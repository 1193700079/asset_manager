"""Unified batch processing for character assets via SmartStudio.

Four batch types, all following: generate -> save as pending media (for review).

  faceswap  : face = character avatar_url; body source has two origins, both
              produce a faceswap result (source label distinguishes them):
                - swap_direct : body = VFE face_nsfw material image
                - swap_zimage : body = a freshly zimage-generated image
  zimage    : per character, K random prompts from VFE annotation library ->
              text-to-image.
  imageedit : per character, K random prompts; base image = character avatar ->
              image edit.
  video     : per character, take existing swap/edit generated images as the
              first frame, pair each with a random VFE video_prompt -> wan video
              (source label notes whether the frame came from swap or edit).

Results are appended to the character's media JSON with media_status='pending'
and a `source` tag, so they show up in the review/待选 area before going online.

Runs one job at a time in a background thread; the thread drives an asyncio
event loop with a concurrency semaphore. Because the DB pool resolves the data
source from a request-scoped contextvar, the worker binds the data source for
its own thread.
"""
import asyncio
import copy
import json
import os
import random
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import aiohttp
import psycopg2.extras

from database import get_conn_for, put_conn_for
from services import smartstudio_client, vfe_client, avatar as avatar_service, comfyui_single
from services import dashscope_client
from services.comfyui_single import (
    COMFYUI_HOST, COMFYUI_PORTS,
    WORKFLOW_SWAP, WORKFLOW_ZIMAGE, WORKFLOW_EDIT, WORKFLOW_VIDEO,
    SWAP_NODE_BODY, SWAP_NODE_FACE, SWAP_NODE_SEED,
    ZIMG_NODE_POS, ZIMG_NODE_NEG, ZIMG_NODE_SEED, ZIMG_NODE_FILE,
    EDIT_NODE_IMAGE, EDIT_NODE_PROMPT, EDIT_NODE_SEED, EDIT_NODE_FILE,
    VID_NODE_IMAGE, VID_NODE_PROMPT, VID_NODE_SEED, VID_NODE_FILE,
    _upload_to_oss,
)

POLL_INTERVAL = 5
POLL_TIMEOUT = 600
CONCURRENCY = 2

PRESET_EDIT_PROMPTS = [
    {
        "id": "anime_standard",
        "label": "标准动漫风",
        "prompt": "convert to high-quality anime art style, clean cel shading, vibrant colors, detailed anime illustration, keep the same character, pose and composition",
    },
    {
        "id": "anime_japanese",
        "label": "日式动漫风 (精致)",
        "prompt": "Convert to authentic Japanese anime art style, stunningly attractive character, beautiful detailed face, clean cel shading, vibrant colors, highly detailed anime illustration, keep the same character, pose and composition.",
    },
    {
        "id": "anime_chibi",
        "label": "Q版/Chibi",
        "prompt": "convert to cute chibi anime style, big head small body, adorable expression, pastel colors, simple clean background, keep the same character identity",
    },
    {
        "id": "anime_ghibli",
        "label": "吉卜力风格",
        "prompt": "convert to Studio Ghibli anime art style, soft watercolor feel, warm gentle lighting, natural scenery, dreamy atmosphere, keep the same character, pose and composition",
    },
]

ANIME_EDIT_PROMPT = PRESET_EDIT_PROMPTS[0]["prompt"]

_lock = threading.Lock()
_jobs: dict[str, dict] = {}
_current_job_id: str | None = None

# Per-character locks to serialize read-modify-write of the media JSON, so that
# concurrent units targeting the same character don't clobber each other.
_media_locks: dict[tuple, threading.Lock] = {}
_media_locks_guard = threading.Lock()

# Persistence: each job is mirrored to logs/jobs/<job_id>.json so it can survive
# a backend crash/restart. Per-unit "status" (pending|done|failed) lets us skip
# already-completed work on resume.
_JOBS_DIR = Path(__file__).resolve().parent.parent / "logs" / "jobs"
_JOBS_DIR.mkdir(parents=True, exist_ok=True)
_PERSIST_KEYS = (
    "job_id", "type", "data_source", "per_character", "category",
    "width", "height", "seed", "edit_prompt", "engine",
    "status", "total", "processed", "succeeded", "failed", "current",
    "results", "error", "started_at", "finished_at",
    "units", "unit_status",
)


def _job_file(job_id: str) -> Path:
    return _JOBS_DIR / f"{job_id}.json"


def _persist_job(job_id: str) -> None:
    """Atomically write the job snapshot to disk. Caller does not need to hold
    the lock — we snapshot under the lock here."""
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            return
        snap = {k: job.get(k) for k in _PERSIST_KEYS if k in job}
    path = _job_file(job_id)
    tmp = path.with_suffix(".tmp")
    try:
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(snap, f, ensure_ascii=False)
        tmp.replace(path)
    except Exception as e:
        # persistence is best-effort; never crash the worker over a disk hiccup
        try: tmp.unlink(missing_ok=True)
        except Exception: pass
        print(f"[batch] persist failed for {job_id}: {e}")


def _slim_unit(btype: str, unit: dict) -> dict:
    """Strip a unit down to the fields we need to rebuild it after a restart.
    The `char` dict is reduced to {id, name}; the worker re-fetches characters
    by id on resume so any DB updates are picked up."""
    ch = unit.get("char") or {}
    base = {"char_id": ch.get("id"), "char_name": ch.get("name")}
    if btype in ("anime",):
        base.update({"prompt": unit.get("prompt"), "edit_prompt": unit.get("edit_prompt")})
    elif btype in ("anime_direct", "zimage"):
        base.update({"prompt": unit.get("prompt")})
    elif btype == "imageedit":
        base.update({"prompt": unit.get("prompt"), "base": unit.get("base")})
    elif btype == "faceswap":
        base.update({
            "face": unit.get("face"),
            "body": unit.get("body"),
            "zimage_prompt": unit.get("zimage_prompt"),
            "origin": unit.get("origin"),
        })
    elif btype == "video":
        base.update({
            "frame": unit.get("frame"),
            "video_prompt": unit.get("video_prompt"),
            "frame_origin": unit.get("frame_origin"),
        })
    elif btype == "profile_video":
        base.update({
            "frame": unit.get("frame"),
            "video_prompt": unit.get("video_prompt"),
            "frame_origin": unit.get("frame_origin"),
        })
    elif btype == "avatar":
        base.update({"src_image": unit.get("src_image")})
    return base


def _hydrate_unit(slim: dict) -> dict:
    """Reverse of _slim_unit. Builds the dict shape the worker/_process_unit
    expects, using just {id, name} for the character (sufficient for the
    helpers that touch it)."""
    return {**{k: v for k, v in slim.items() if k not in ("char_id", "char_name")},
            "char": {"id": slim.get("char_id"), "name": slim.get("char_name")}}


def _media_lock(ds: str, char_id: int) -> threading.Lock:
    key = (ds, char_id)
    with _media_locks_guard:
        lk = _media_locks.get(key)
        if lk is None:
            lk = threading.Lock()
            _media_locks[key] = lk
        return lk


# ----------------------------------------------------------------- helpers
def _vfe_image_url(item: dict) -> str | None:
    """Pick a fetchable URL (oss_url preferred, fallback to VFE local serve)."""
    oss = item.get("oss_url")
    if oss:
        return oss
    img = item.get("image_url")
    if img:
        from config import settings
        return settings.vfe_url.rstrip("/") + img
    return None


def _parse_media(raw):
    if raw is None:
        return []
    if isinstance(raw, list):
        return raw
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []


def _fetch_characters(ds: str, category: str | None) -> list[dict]:
    conn = get_conn_for(ds)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            q = """SELECT id, name, description, attributes, avatar_url, media
                   FROM characters
                   WHERE (is_deleted IS NULL OR is_deleted = FALSE)
                     AND creator_id = 'official'"""
            params: list = []
            if category:
                cats = [c.strip() for c in category.split(",") if c.strip()]
                if "anime" in cats:
                    cats.extend(["anime_male", "anime_female"])
                    cats = list(set(cats))
                q += " AND category = ANY(%s)"
                params.append(cats)
            q += " ORDER BY name"
            cur.execute(q, params)
            return [dict(r) for r in cur.fetchall()]
    finally:
        put_conn_for(ds, conn)


def _append_media(ds: str, char_id: int, url: str, media_type: str, source: str, extra: dict | None = None):
    if url and url.startswith("http"):
        import requests as _req
        try:
            r = _req.head(url, timeout=10, allow_redirects=True)
            if r.status_code >= 400:
                raise RuntimeError(f"Generated URL not accessible (HTTP {r.status_code}): {url[:120]}")
        except _req.RequestException as e:
            raise RuntimeError(f"Generated URL unreachable: {url[:120]} ({type(e).__name__})")

    with _media_lock(ds, char_id):
        conn = get_conn_for(ds)
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("SELECT media FROM characters WHERE id = %s", (char_id,))
                row = cur.fetchone()
                media_list = _parse_media(row["media"]) if row else []
                item = {
                    "url": url,
                    "type": media_type,
                    "source": source,
                    "media_status": "pending",
                    "created_at": datetime.now(timezone.utc).isoformat(),
                }
                if extra:
                    item.update(extra)
                media_list.append(item)
                cur.execute(
                    "UPDATE characters SET media = %s::json WHERE id = %s",
                    (json.dumps(media_list), char_id),
                )
            conn.commit()
        finally:
            put_conn_for(ds, conn)


def _set_avatar(ds: str, char_id: int, url: str):
    conn = get_conn_for(ds)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE characters SET avatar_url = %s WHERE id = %s",
                (url, char_id),
            )
        conn.commit()
    finally:
        put_conn_for(ds, conn)


# Variation pools — randomly picked per generation so same character produces
# diverse images (different scenes/outfits/poses) while keeping identity.
SCENE_POOL = [
    "in a sunlit cozy bedroom",
    "in a modern minimalist apartment",
    "on a rooftop at golden hour",
    "in a vintage cafe with warm light",
    "by a large window with soft daylight",
    "in a cherry blossom garden",
    "on a quiet city street at sunset",
    "in a stylish library with bookshelves",
    "at a beach with ocean breeze",
    "in a softly lit studio with neutral backdrop",
    "in a flower-filled balcony garden",
    "at a night cityscape with bokeh lights",
    "in a traditional Japanese tatami room",
    "in a cozy kitchen with morning light",
    "in an art studio with paintings around",
]
OUTFIT_POOL = [
    "casual oversized sweater",
    "elegant white dress",
    "stylish denim jacket and jeans",
    "soft pastel knit cardigan",
    "school uniform with blazer",
    "summer floral dress",
    "cozy hoodie",
    "office blouse and pencil skirt",
    "athletic crop top and leggings",
    "cute sundress",
    "silk pajamas",
    "vintage 90s outfit",
    "leather jacket with t-shirt",
    "kimono with traditional patterns",
    "elegant evening dress",
]
POSE_POOL = [
    "sitting gracefully",
    "standing confidently with hands in pockets",
    "leaning against a wall casually",
    "looking back over shoulder",
    "holding a coffee cup with both hands",
    "sitting on a bed reading a book",
    "stretching after waking up",
    "hand brushing hair behind ear",
    "playful peace sign gesture",
    "thoughtful pose with hand on chin",
    "walking towards camera",
    "lying down resting on elbow",
]
EXPRESSION_POOL = [
    "warm gentle smile",
    "playful smirk",
    "soft thoughtful gaze",
    "shy pretty smile",
    "intense focused look",
    "happy laughter",
    "calm serene expression",
    "cheeky wink",
    "dreamy distant gaze",
    "confident smile",
]
LIGHTING_POOL = [
    "warm golden hour lighting",
    "soft natural window light",
    "moody cinematic lighting",
    "bright daylight",
    "neon city night lighting",
    "soft pastel color grading",
    "rim lighting from behind",
    "diffused studio lighting",
]
FRAMING_POOL = [
    "upper body portrait",
    "medium shot from waist up",
    "full body shot",
    "close-up portrait",
    "three-quarter angle shot",
]


def _build_prompt(name: str, description, attributes) -> str:
    """Build a portrait-card prompt with random scene/outfit/pose variation."""
    import random as _random
    if isinstance(attributes, str):
        try:
            attributes = json.loads(attributes)
        except (json.JSONDecodeError, TypeError):
            attributes = {}
    attributes = attributes or {}

    age = attributes.get("Age", "")
    ethnicity = attributes.get("Ethnicity", "")
    body = attributes.get("Body", "")
    occupation = attributes.get("Occupation", "")
    personality = attributes.get("Personality", "")
    relationship = attributes.get("Relationship", "")

    is_female = any(kw in (relationship + " " + occupation).lower()
                    for kw in ("girlfriend", "wife", "girl", "woman", "actress", "model"))
    is_male = any(kw in (relationship + " " + occupation).lower()
                  for kw in ("boyfriend", "husband", "boy", "man", "actor"))

    subject_parts = []
    if age:
        subject_parts.append(f"{age} year old")
    if ethnicity:
        subject_parts.append(ethnicity)
    if body:
        subject_parts.append(f"{body} build")
    if is_female:
        subject_parts.append("beautiful young woman")
    elif is_male:
        subject_parts.append("handsome young man")
    else:
        subject_parts.append("stunningly attractive person")
    subject = " ".join(subject_parts)

    scene = _random.choice(SCENE_POOL)
    outfit = _random.choice(OUTFIT_POOL)
    pose = _random.choice(POSE_POOL)
    expression = _random.choice(EXPRESSION_POOL)
    lighting = _random.choice(LIGHTING_POOL)
    framing = _random.choice(FRAMING_POOL)

    vibe = ""
    if personality:
        v = personality.split(",")[0].strip().split(".")[0].strip()
        if v:
            vibe = v.lower()

    lines = [
        f"solo, single person, {framing} of {subject}",
        f"character: {name}",
        "beautiful detailed face, perfect facial features, flawless skin, attractive",
        f"wearing {outfit}",
        f"{pose}",
        f"{expression}" + (f", {vibe} energy" if vibe else ""),
        f"setting: {scene}",
        f"{lighting}",
    ]
    if occupation:
        lines.append(f"occupation hint: {occupation}")

    lines.append(
        "looking at viewer, high quality, masterpiece, best quality, "
        "detailed, shallow depth of field, no other people, single subject only"
    )

    return ", ".join(lines)[:1500]


async def _persist_url(url: str, task_id: str) -> str:
    """Download a temporary URL and re-upload to permanent OSS.
    Returns the permanent OSS URL, or the original URL if already permanent."""
    from config import settings
    own_domain = settings.oss_bucket + "." + settings.oss_endpoint.replace("https://", "").replace("http://", "")
    if own_domain in url and "x-oss-expires" not in url:
        return url

    try:
        import oss2, tempfile
        ext = ".png"
        if ".mp4" in url.split("?")[0]:
            ext = ".mp4"
        elif ".webm" in url.split("?")[0]:
            ext = ".webm"

        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=60)) as resp:
                if resp.status != 200:
                    print(f"[batch] WARN: download failed {resp.status}, using original URL")
                    return url
                data = await resp.read()

        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)
        bucket = oss2.Bucket(auth, settings.oss_endpoint, settings.oss_bucket)
        filename = f"{task_id}{ext}"
        oss_key = f"{settings.oss_prefix}{task_id}/{filename}"
        bucket.put_object_from_file(oss_key, tmp_path)
        os.unlink(tmp_path)

        endpoint = settings.oss_endpoint.replace("https://", "").replace("http://", "")
        permanent_url = f"https://{settings.oss_bucket}.{endpoint}/{oss_key}"
        print(f"[batch] Persisted URL: {permanent_url}")
        return permanent_url
    except Exception as e:
        print(f"[batch] WARN: persist_url failed ({e}), using original URL")
        return url


async def _run_and_wait(submit_coro) -> str:
    task_id = await submit_coro
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        await asyncio.sleep(POLL_INTERVAL)
        out = await smartstudio_client.poll_task(task_id)
        status = (out.get("task_status") or "").upper()
        if status == "SUCCEEDED":
            url = out.get("image_url") or out.get("video_url")
            if not url:
                raise RuntimeError("succeeded but no result url")
            url = await _persist_url(url, task_id)
            return url
        if status == "FAILED":
            raise RuntimeError(out.get("task_message") or out.get("error_message") or "task failed")
    raise RuntimeError(f"timed out after {POLL_TIMEOUT}s")


COMFYUI_OUTPUT_DIR = Path("/mnt/cypher/project/ComfyUI/output")
COMFYUI_POLL_INTERVAL = 3
COMFYUI_POLL_TIMEOUT = 300

_workflow_cache: dict[str, dict] = {}


def _load_wf(wf_path: str) -> dict:
    with open(wf_path, "r", encoding="utf-8") as f:
        return json.load(f)


async def _find_free_port(session: aiohttp.ClientSession) -> int | None:
    best_port, best_size = None, float("inf")
    for port in COMFYUI_PORTS:
        try:
            async with session.get(
                f"http://{COMFYUI_HOST}:{port}/queue",
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    size = len(data.get("queue_running", [])) + len(data.get("queue_pending", []))
                    if size < best_size:
                        best_size = size
                        best_port = port
        except Exception:
            pass
    return best_port


async def _upload_image_comfy(session: aiohttp.ClientSession, port: int, image_url: str, filename: str) -> str:
    """Download image from URL and upload to ComfyUI instance, return server filename."""
    if image_url.startswith(("http://", "https://")):
        async with session.get(image_url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
            resp.raise_for_status()
            data = aiohttp.FormData()
            content = await resp.read()
            data.add_field("image", content, filename=filename, content_type="image/png")
    elif Path(image_url).exists():
        content = Path(image_url).read_bytes()
        data = aiohttp.FormData()
        data.add_field("image", content, filename=Path(image_url).name, content_type="image/png")
    else:
        raise FileNotFoundError(f"Image not accessible: {image_url}")

    async with session.post(
        f"http://{COMFYUI_HOST}:{port}/upload/image",
        data=data,
        timeout=aiohttp.ClientTimeout(total=30),
    ) as resp:
        resp.raise_for_status()
        result = await resp.json()
        return result["name"]


async def _submit_and_poll_comfy(session: aiohttp.ClientSession, port: int, workflow: dict,
                                  is_stopping=None) -> dict:
    """Submit workflow to ComfyUI and poll until done. Returns {ok, files, error}."""
    async with session.post(
        f"http://{COMFYUI_HOST}:{port}/prompt",
        json={"prompt": workflow},
        timeout=aiohttp.ClientTimeout(total=30),
    ) as resp:
        resp_data = await resp.json()
        if "prompt_id" not in resp_data:
            err = resp_data.get("error", {}).get("message", "") or str(resp_data)
            return {"ok": False, "error": f"ComfyUI submit error: {err[:300]}"}
        prompt_id = resp_data["prompt_id"]

    elapsed = 0
    while elapsed < COMFYUI_POLL_TIMEOUT:
        if is_stopping and is_stopping():
            return {"ok": False, "error": "job stopped"}
        await asyncio.sleep(COMFYUI_POLL_INTERVAL)
        elapsed += COMFYUI_POLL_INTERVAL
        try:
            async with session.get(
                f"http://{COMFYUI_HOST}:{port}/history/{prompt_id}",
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                if resp.status != 200:
                    continue
                data = await resp.json()
                if prompt_id not in data:
                    continue
                entry = data[prompt_id]
                status = entry.get("status", {})
                if status.get("status_str") == "error":
                    msgs = status.get("messages", [])
                    err_msg = str(msgs[-1] if msgs else "execution_error")[:300]
                    return {"ok": False, "error": err_msg}
                if status.get("completed", False) or "outputs" in entry:
                    filenames = []
                    for node_output in entry.get("outputs", {}).values():
                        for img in node_output.get("images", []):
                            if img.get("type") != "output":
                                continue
                            fname = img.get("filename", "")
                            subfolder = img.get("subfolder", "")
                            filenames.append(f"{subfolder}/{fname}" if subfolder else fname)
                    return {"ok": True, "files": filenames}
        except Exception:
            pass

    return {"ok": False, "error": f"ComfyUI poll timeout after {COMFYUI_POLL_TIMEOUT}s"}


async def _comfy_run(session: aiohttp.ClientSession, task_type: str,
                     image_url: str = "", face_url: str = "",
                     prompt: str = "", seed: int = 0,
                     is_stopping=None) -> str:
    """Pure-async ComfyUI execution: upload, submit, poll, upload result to OSS."""
    if seed == 0:
        seed = random.randint(0, 2**31 - 1)

    port = await _find_free_port(session)
    if port is None:
        raise RuntimeError("No available ComfyUI instance")

    job_id = uuid.uuid4().hex[:12]

    if task_type == "comfy_swap":
        wf = _load_wf(WORKFLOW_SWAP)
        body_name = await _upload_image_comfy(session, port, image_url, "body.png")
        face_name = await _upload_image_comfy(session, port, face_url, "face.png")
        wf[SWAP_NODE_BODY]["inputs"]["image"] = body_name
        wf[SWAP_NODE_FACE]["inputs"]["image"] = face_name
        wf[SWAP_NODE_SEED]["inputs"]["noise_seed"] = seed

    elif task_type == "comfy_zimage":
        wf = _load_wf(WORKFLOW_ZIMAGE)
        wf[ZIMG_NODE_POS]["inputs"]["text"] = prompt
        wf[ZIMG_NODE_NEG]["inputs"]["text"] = "blurry, ugly, bad anatomy, deformed, low quality"
        wf[ZIMG_NODE_SEED]["inputs"]["seed"] = seed
        wf[ZIMG_NODE_FILE]["inputs"]["filename_prefix"] = f"batch/zimg_{job_id}"
        if "10" in wf and wf["10"].get("class_type") == "EmptyLatentImage":
            wf["10"]["inputs"]["width"] = 720
            wf["10"]["inputs"]["height"] = 1280

    elif task_type == "comfy_edit":
        wf = _load_wf(WORKFLOW_EDIT)
        img_name = await _upload_image_comfy(session, port, image_url, "edit_input.png")
        wf[EDIT_NODE_IMAGE]["inputs"]["image"] = img_name
        wf[EDIT_NODE_PROMPT]["inputs"]["prompt"] = prompt
        wf[EDIT_NODE_SEED]["inputs"]["seed"] = seed
        wf[EDIT_NODE_FILE]["inputs"]["filename_prefix"] = f"batch/edit_{job_id}"

    elif task_type == "comfy_video":
        wf = _load_wf(WORKFLOW_VIDEO)
        img_name = await _upload_image_comfy(session, port, image_url, "vid_input.png")
        wf[VID_NODE_IMAGE]["inputs"]["image"] = img_name
        if prompt:
            wf[VID_NODE_PROMPT]["inputs"]["value"] = prompt
        wf[VID_NODE_SEED]["inputs"]["noise_seed"] = seed
        wf[VID_NODE_FILE]["inputs"]["filename_prefix"] = f"batch/vid_{job_id}"

    else:
        raise RuntimeError(f"Unknown comfy task type: {task_type}")

    result = await _submit_and_poll_comfy(session, port, wf, is_stopping=is_stopping)
    if not result["ok"]:
        raise RuntimeError(result["error"])

    files = result.get("files", [])
    if not files:
        raise RuntimeError("ComfyUI returned no output files")

    local_path = str(COMFYUI_OUTPUT_DIR / files[0])
    if not Path(local_path).exists():
        raise RuntimeError(f"Output file not found: {local_path}")

    public_url = _upload_to_oss(local_path, job_id)
    if not public_url:
        public_url = f"/api/comfyui/result/{job_id}/{Path(files[0]).name}"
    return public_url


# Per-event-loop aiohttp sessions. The batch worker runs in its own thread
# with its own asyncio loop, so a process-wide singleton would leak across
# loops and surface as "Event loop is closed" once the previous worker's loop
# is torn down. Keying by id(loop) keeps each loop's session isolated.
_aio_sessions: dict[int, aiohttp.ClientSession] = {}


def _session_key() -> int:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = asyncio.get_event_loop()
    return id(loop)


async def _get_session() -> aiohttp.ClientSession:
    key = _session_key()
    sess = _aio_sessions.get(key)
    if sess is None or sess.closed:
        sess = aiohttp.ClientSession()
        _aio_sessions[key] = sess
    return sess


async def _close_session() -> None:
    key = _session_key()
    sess = _aio_sessions.pop(key, None)
    if sess and not sess.closed:
        await sess.close()


async def _gen_zimage(engine: str, prompt: str, w: int, h: int, seed: int, is_stopping=None) -> str:
    if engine == "comfyui":
        session = await _get_session()
        return await _comfy_run(session, "comfy_zimage", prompt=prompt, seed=seed, is_stopping=is_stopping)
    if engine == "dashscope":
        return await dashscope_client.create_zimage(prompt, w, h, seed)
    return await _run_and_wait(smartstudio_client.create_zimage(prompt, w, h, seed))


async def _gen_imageedit(engine: str, image: str, prompt: str, seed: int, is_stopping=None) -> str:
    if engine == "comfyui":
        session = await _get_session()
        return await _comfy_run(session, "comfy_edit", image_url=image, prompt=prompt, seed=seed, is_stopping=is_stopping)
    return await _run_and_wait(smartstudio_client.create_imageedit(image, prompt, seed))


async def _gen_faceswap(engine: str, body: str, face: str, seed: int, is_stopping=None) -> str:
    if engine == "comfyui":
        session = await _get_session()
        return await _comfy_run(session, "comfy_swap", image_url=body, face_url=face, seed=seed, is_stopping=is_stopping)
    return await _run_and_wait(smartstudio_client.create_faceswap(body, face, seed))


async def _gen_video(engine: str, image: str, prompt: str, seed: int, is_stopping=None) -> str:
    if engine == "comfyui":
        session = await _get_session()
        return await _comfy_run(session, "comfy_video", image_url=image, prompt=prompt, seed=seed, is_stopping=is_stopping)
    return await _run_and_wait(smartstudio_client.create_wan_spicy(image, prompt, seed=seed))


# ----------------------------------------------------------------- unit builders
async def _build_units(job: dict, ds: str) -> list[dict]:
    """Return a flat list of work units; each unit is a dict describing one
    generation that yields one media item."""
    btype = job["type"]
    per = job["per_character"]
    category = job["category"]
    chars = _fetch_characters(ds, category)
    job_meta = {"char_total": len(chars)}
    units: list[dict] = []

    if btype == "anime":
        # zimage (per-character prompt) -> imageedit anime restyle chain.
        edit_prompt = job.get("edit_prompt") or ANIME_EDIT_PROMPT
        for ch in chars:
            zp = _build_prompt(ch["name"], ch.get("description"), ch.get("attributes"))
            for _ in range(per):
                units.append({"char": ch, "prompt": zp, "edit_prompt": edit_prompt})

    elif btype == "anime_direct":
        # zimage direct: anime style baked into the prompt, single-step generation.
        edit_prompt = job.get("edit_prompt") or ANIME_EDIT_PROMPT
        for ch in chars:
            base_prompt = _build_prompt(ch["name"], ch.get("description"), ch.get("attributes"))
            # Replace "professional portrait photo" with anime-style prefix
            anime_prompt = base_prompt.replace(
                "professional portrait photo of",
                "anime illustration of"
            )
            # Prepend anime style keywords from the edit prompt
            style_prefix = edit_prompt.split(",")[0].strip()  # e.g. "Convert to authentic Japanese anime art style"
            full_prompt = f"{style_prefix}, {anime_prompt}"
            for _ in range(per):
                units.append({"char": ch, "prompt": full_prompt})

    elif btype == "zimage":
        # Pull a shared pool of prompts; assign per character.
        for ch in chars:
            mats = await vfe_client.search_images(limit=per, offset=0, order="random")
            prompts = [it.get("prompt") for it in mats.get("items", []) if it.get("prompt")]
            for p in prompts[:per]:
                units.append({"char": ch, "prompt": p})

    elif btype == "imageedit":
        for ch in chars:
            if not ch.get("avatar_url"):
                continue
            mats = await vfe_client.search_images(limit=per, offset=0, order="random")
            prompts = [it.get("prompt") for it in mats.get("items", []) if it.get("prompt")]
            for p in prompts[:per]:
                edit_instruction = (
                    f"Keep the same person's face and identity consistent. "
                    f"Place this person in the following scene: {p}"
                )
                units.append({"char": ch, "prompt": edit_instruction, "base": ch["avatar_url"]})

    elif btype == "faceswap":
        for ch in chars:
            if not ch.get("avatar_url"):
                continue
            # Pull VFE face_nsfw materials (now includes prompt from annotation join)
            mats = await vfe_client.get_faceswap_materials(limit=per)
            items = mats.get("items", [])
            # swap_direct: body = VFE material image directly
            for it in items[:per]:
                body = _vfe_image_url(it)
                if body:
                    units.append({"char": ch, "face": ch["avatar_url"], "body": body, "origin": "swap_direct"})
            # swap_zimage: body generated by zimage using the material's prompt
            for it in items[:per]:
                p = it.get("prompt")
                if p:
                    units.append({"char": ch, "face": ch["avatar_url"], "zimage_prompt": p, "origin": "swap_zimage"})

    elif btype == "video":
        for ch in chars:
            media = _parse_media(ch.get("media"))
            frames = [
                m for m in media
                if isinstance(m, dict) and m.get("type") == "image"
                and m.get("source") in ("swap_direct", "swap_zimage", "imageedit", "zimage", "zimage_anime", "zimage_anime_direct")
                and m.get("url")
                and not m.get("is_deleted")
            ]
            for fr in frames[:per]:
                vps = await vfe_client.get_video_prompts(limit=1)
                items = vps.get("items", [])
                if not items or not items[0].get("video_prompt"):
                    continue
                frame_origin = "swap" if str(fr.get("source", "")).startswith("swap") else "edit"
                units.append({
                    "char": ch,
                    "frame": fr["url"],
                    "video_prompt": items[0]["video_prompt"],
                    "frame_origin": frame_origin,
                })

    elif btype == "profile_video":
        for ch in chars:
            media = _parse_media(ch.get("media"))
            first_profile = next(
                (m["url"] for m in media
                 if isinstance(m, dict) and m.get("type") == "image"
                 and m.get("url") and not m.get("is_deleted")
                 and m.get("media_status") != "pending"),
                None,
            )
            if not first_profile:
                continue
            for _ in range(per):
                units.append({
                    "char": ch,
                    "frame": first_profile,
                    "video_prompt": None,
                    "frame_origin": "profile",
                })

    elif btype == "avatar":
        overwrite = job.get("overwrite", False)
        for ch in chars:
            if ch.get("avatar_url") and not overwrite:
                continue
            media = _parse_media(ch.get("media"))
            first_img = next(
                (m["url"] for m in media
                 if isinstance(m, dict) and m.get("type") == "image"
                 and m.get("url") and not m.get("is_deleted")
                 and m.get("media_status") != "pending"),
                None,
            )
            if first_img:
                units.append({"char": ch, "src_image": first_img})

    job["_meta"] = job_meta
    return units


async def _process_unit(ds: str, btype: str, unit: dict, seed: int, w: int, h: int, engine: str = "smartstudio", is_stopping=None):
    ch = unit["char"]
    if btype == "anime":
        ep = unit.get("edit_prompt") or ANIME_EDIT_PROMPT
        base = await _gen_zimage(engine, unit["prompt"], w, h, seed, is_stopping=is_stopping)
        url = await _gen_imageedit(engine, base, ep, seed, is_stopping=is_stopping)
        _append_media(ds, ch["id"], url, "image", "zimage_anime",
                      {"prompt": unit["prompt"], "edit_prompt": ep, "engine": engine})

    elif btype == "anime_direct":
        url = await _gen_zimage(engine, unit["prompt"], w, h, seed, is_stopping=is_stopping)
        _append_media(ds, ch["id"], url, "image", "zimage_anime_direct",
                      {"prompt": unit["prompt"], "engine": engine})

    elif btype == "zimage":
        url = await _gen_zimage(engine, unit["prompt"], w, h, seed, is_stopping=is_stopping)
        _append_media(ds, ch["id"], url, "image", "zimage", {"prompt": unit["prompt"], "engine": engine})

    elif btype == "imageedit":
        url = await _gen_imageedit(engine, unit["base"], unit["prompt"], seed, is_stopping=is_stopping)
        _append_media(ds, ch["id"], url, "image", "imageedit", {"prompt": unit["prompt"], "engine": engine})

    elif btype == "faceswap":
        if unit["origin"] == "swap_zimage":
            body = await _gen_zimage(engine, unit["zimage_prompt"], w, h, seed, is_stopping=is_stopping)
        else:
            body = unit["body"]
        url = await _gen_faceswap(engine, body, unit["face"], seed, is_stopping=is_stopping)
        _append_media(ds, ch["id"], url, "image", unit["origin"], {"model_source": unit["origin"], "engine": engine})

    elif btype == "video":
        url = await _gen_video(engine, unit["frame"], unit["video_prompt"], seed, is_stopping=is_stopping)
        _append_media(ds, ch["id"], url, "video", f"video_{unit['frame_origin']}",
                      {"frame_origin": unit["frame_origin"], "video_prompt": unit["video_prompt"], "engine": engine})

    elif btype == "profile_video":
        vp = unit.get("video_prompt")
        if not vp:
            try:
                vp = await dashscope_client.generate_video_prompt(unit["frame"])
            except Exception:
                vp = "The person smiles gently, shifts their gaze naturally, with subtle head movement and soft hair sway. Cinematic, natural lighting."
        url = await _gen_video(engine, unit["frame"], vp, seed, is_stopping=is_stopping)
        _append_media(ds, ch["id"], url, "video", "video_profile",
                      {"frame_origin": "profile", "video_prompt": vp, "engine": engine})

    elif btype == "avatar":
        result = await avatar_service.generate_avatar(unit["src_image"])
        if not result.get("ok"):
            raise RuntimeError(result.get("error", "avatar generation failed"))
        _set_avatar(ds, ch["id"], result["avatar_url"])


# ----------------------------------------------------------------- worker
def _worker(job_id: str, ds: str, *, resume: bool = False):
    job = _jobs[job_id]
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    btype = job["type"]
    engine = job.get("engine", "smartstudio")

    async def _run():
        # ── build (or rehydrate) the unit list ─────────────────────────────
        if resume and job.get("units"):
            units = [_hydrate_unit(s) for s in job["units"]]
            unit_status = list(job.get("unit_status") or [])
            if len(unit_status) != len(units):
                unit_status = ["pending"] * len(units)
        else:
            with _lock:
                job["status"] = "building"
            _persist_job(job_id)
            # Fail-fast: types that pull material from VFE are useless without it.
            if btype in ("zimage", "imageedit", "faceswap", "video"):
                ping = await vfe_client.ping(timeout=3.0)
                if not ping.get("ok"):
                    raise RuntimeError(
                        f"VFE 后端不可用，已取消批处理。请先启动 VFE: "
                        f"`cd video-frame-extractor && npm run server:daemon`。详情: {ping.get('error')}"
                    )
            built = await _build_units(job, ds)
            units = built
            slim = [_slim_unit(btype, u) for u in built]
            unit_status = ["pending"] * len(built)
            with _lock:
                job["units"] = slim
                job["unit_status"] = unit_status
                job["total"] = len(built)
            _persist_job(job_id)

        if btype == "avatar":
            conc = CONCURRENCY
        elif engine == "comfyui":
            conc = len(COMFYUI_PORTS)
        elif engine == "dashscope":
            conc = 4
        else:
            conc = CONCURRENCY
        with _lock:
            job["status"] = "running"
        _persist_job(job_id)

        sem = asyncio.Semaphore(conc)

        def _check_stopping():
            with _lock:
                return job["status"] == "stopping"

        async def _one(idx: int, unit: dict):
            if _check_stopping():
                return
            if unit_status[idx] == "done":
                return  # already completed in a previous run
            async with sem:
                if _check_stopping():
                    return
                with _lock:
                    job["current"] = (unit.get("char") or {}).get("name")
                max_retries = 2
                for attempt in range(max_retries + 1):
                    try:
                        await _process_unit(ds, btype, unit, job["seed"], job["width"], job["height"], engine, is_stopping=_check_stopping)
                        with _lock:
                            unit_status[idx] = "done"
                            job["unit_status"] = unit_status
                            job["succeeded"] += 1
                            job["processed"] += 1
                        _persist_job(job_id)
                        return
                    except asyncio.CancelledError:
                        return
                    except Exception as e:
                        if attempt < max_retries and not _check_stopping():
                            await asyncio.sleep(3)
                            continue
                        with _lock:
                            unit_status[idx] = "failed"
                            job["unit_status"] = unit_status
                            job["failed"] += 1
                            job["processed"] += 1
                            job["results"].append({
                                "char": (unit.get("char") or {}).get("name"),
                                "ok": False,
                                "error": str(e)[:200] or type(e).__name__,
                            })
                        _persist_job(job_id)
                        return

        # On resume: re-tally counters from unit_status so the UI is honest.
        if resume:
            done = sum(1 for s in unit_status if s == "done")
            failed = sum(1 for s in unit_status if s == "failed")
            with _lock:
                job["succeeded"] = done
                job["failed"] = failed
                job["processed"] = done + failed
            _persist_job(job_id)

        tasks = [asyncio.create_task(_one(i, u)) for i, u in enumerate(units)]

        async def _stop_monitor():
            while True:
                await asyncio.sleep(1)
                if _check_stopping():
                    for t in tasks:
                        if not t.done():
                            t.cancel()
                    break

        monitor = asyncio.create_task(_stop_monitor())
        await asyncio.gather(*tasks, return_exceptions=True)
        monitor.cancel()
        try:
            await monitor
        except asyncio.CancelledError:
            pass

    try:
        loop.run_until_complete(_run())
        with _lock:
            job["status"] = "stopped" if job["status"] == "stopping" else "completed"
            job["current"] = None
            job["finished_at"] = datetime.now(timezone.utc).isoformat()
        _persist_job(job_id)
    except Exception as e:
        with _lock:
            job["status"] = "error"
            job["error"] = str(e)[:300]
        _persist_job(job_id)
    finally:
        # Close any HTTP clients that were created against this worker's loop
        # while the loop is still alive. Doing this after loop.close() — or
        # leaving them in a process-wide singleton — leaks closed-loop
        # transports and breaks the next batch run with "Event loop is closed".
        try:
            loop.run_until_complete(_close_session())
        except Exception as ce:
            print(f"[batch] aiohttp session close failed: {ce}")
        try:
            loop.run_until_complete(vfe_client.close_client())
        except Exception as ce:
            print(f"[batch] vfe httpx client close failed: {ce}")
        loop.close()


# ----------------------------------------------------------------- public API
VALID_TYPES = {"anime", "anime_direct", "faceswap", "zimage", "imageedit", "video", "profile_video", "avatar"}


def start_job(ds: str, btype: str, per_character: int = 10, category: str | None = None,
              width: int = 1024, height: int = 1536, seed: int = 0,
              edit_prompt: str | None = None, engine: str = "smartstudio",
              overwrite: bool = False) -> dict:
    global _current_job_id
    if btype not in VALID_TYPES:
        return {"status": "error", "message": f"未知批处理类型: {btype}"}
    if engine not in ("smartstudio", "comfyui", "dashscope"):
        engine = "smartstudio"
    with _lock:
        if _current_job_id and _jobs.get(_current_job_id, {}).get("status") in ("running", "stopping", "building", "starting"):
            return {"status": "error", "message": "已有批处理在运行中", "job_id": _current_job_id}
        job_id = uuid.uuid4().hex
        _jobs[job_id] = {
            "job_id": job_id, "type": btype, "data_source": ds,
            "per_character": max(1, min(per_character, 50)),
            "category": category, "width": width, "height": height, "seed": seed,
            "edit_prompt": (edit_prompt or "").strip() or ANIME_EDIT_PROMPT,
            "engine": engine,
            "overwrite": overwrite,
            "status": "starting", "total": 0, "processed": 0,
            "succeeded": 0, "failed": 0, "current": None,
            "results": [], "error": None,
            "started_at": datetime.now(timezone.utc).isoformat(), "finished_at": None,
            "units": [], "unit_status": [],
        }
        _current_job_id = job_id
    _persist_job(job_id)
    threading.Thread(target=_worker, args=(job_id, ds), daemon=True).start()
    return {"status": "ok", "job_id": job_id}


def resume_job(job_id: str | None = None) -> dict:
    """Resume a previously interrupted job. Skips units already marked done.
    If job_id is omitted, picks the most recently interrupted job on disk."""
    global _current_job_id
    with _lock:
        if _current_job_id and _jobs.get(_current_job_id, {}).get("status") in ("running", "stopping", "building", "starting"):
            return {"status": "error", "message": "已有批处理在运行中", "job_id": _current_job_id}
        # Resolve target job: explicit id, or most recent interrupted on disk.
        target = job_id
        if not target:
            candidates = [j for j in _jobs.values() if j.get("status") in ("interrupted", "stopped", "error")]
            if not candidates:
                return {"status": "error", "message": "没有可恢复的批处理"}
            candidates.sort(key=lambda j: j.get("started_at") or "", reverse=True)
            target = candidates[0]["job_id"]
        job = _jobs.get(target)
        if not job:
            return {"status": "error", "message": f"任务 {target} 不存在"}
        if job.get("status") in ("running", "stopping", "building", "starting"):
            return {"status": "error", "message": "任务已经在运行"}
        if not job.get("units"):
            return {"status": "error", "message": "该任务没有可恢复的 units（早期版本未持久化）"}
        ds = job.get("data_source")
        job["status"] = "starting"
        job["error"] = None
        job["finished_at"] = None
        job["current"] = None
        _current_job_id = target
    _persist_job(target)
    threading.Thread(target=_worker, args=(target, ds), kwargs={"resume": True}, daemon=True).start()
    return {"status": "ok", "job_id": target, "message": "已恢复"}


def get_job(job_id: str | None = None) -> dict | None:
    with _lock:
        jid = job_id or _current_job_id
        if not jid:
            return None
        job = _jobs.get(jid)
        if not job:
            return None
        # Keep response payload small: hide internal-only fields.
        hidden = {"units", "unit_status"}
        out = {k: v for k, v in job.items() if not k.startswith("_") and k not in hidden}
        # Surface a hint that this job is resumable.
        if job.get("status") in ("interrupted", "stopped", "error") and job.get("units"):
            done = sum(1 for s in (job.get("unit_status") or []) if s == "done")
            out["resumable"] = True
            out["resumable_remaining"] = max(0, len(job["units"]) - done)
        return out


def list_jobs() -> list[dict]:
    """Lightweight listing for the UI: most recent first."""
    with _lock:
        items = []
        for j in _jobs.values():
            items.append({
                "job_id": j["job_id"],
                "type": j.get("type"),
                "status": j.get("status"),
                "total": j.get("total", 0),
                "processed": j.get("processed", 0),
                "succeeded": j.get("succeeded", 0),
                "failed": j.get("failed", 0),
                "started_at": j.get("started_at"),
                "finished_at": j.get("finished_at"),
                "resumable": bool(j.get("units") and j.get("status") in ("interrupted", "stopped", "error")),
            })
    items.sort(key=lambda x: x.get("started_at") or "", reverse=True)
    return items


def stop_job(job_id: str | None = None) -> dict:
    with _lock:
        jid = job_id or _current_job_id
        job = _jobs.get(jid) if jid else None
        if not job:
            return {"status": "error", "message": "任务不存在"}
        if job["status"] in ("running", "starting", "building"):
            job["status"] = "stopping"
            _need_persist = True
        else:
            _need_persist = False
            return {"status": "ok", "message": f"任务已是 {job['status']}"}
    if _need_persist:
        _persist_job(jid)
    return {"status": "ok", "message": "正在停止"}


def recover_on_startup() -> None:
    """Load all persisted jobs from disk. Any job that was running/stopping/
    building/starting at crash time is marked 'interrupted' so the UI can
    surface a resume button. This is a no-op if there are no job files."""
    global _current_job_id
    if not _JOBS_DIR.exists():
        return
    files = sorted(_JOBS_DIR.glob("*.json"))
    loaded = 0
    interrupted = 0
    for fp in files:
        try:
            with fp.open("r", encoding="utf-8") as f:
                snap = json.load(f)
        except Exception as e:
            print(f"[batch] skip corrupt job file {fp.name}: {e}")
            continue
        jid = snap.get("job_id")
        if not jid:
            continue
        if snap.get("status") in ("running", "stopping", "building", "starting"):
            snap["status"] = "interrupted"
            interrupted += 1
        with _lock:
            _jobs[jid] = snap
        loaded += 1
    if loaded:
        print(f"[batch] recovered {loaded} job(s) from disk ({interrupted} marked interrupted)")
    # Re-persist the rewritten statuses.
    for jid in list(_jobs.keys()):
        if _jobs[jid].get("status") == "interrupted":
            _persist_job(jid)
