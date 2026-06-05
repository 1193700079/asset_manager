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
import json
import threading
import time
import uuid
from datetime import datetime, timezone

import psycopg2.extras

from database import get_conn_for, put_conn_for
from services import smartstudio_client, vfe_client, avatar as avatar_service, comfyui_single

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
    """Pick a publicly-fetchable URL for SmartStudio (oss_url preferred)."""
    return item.get("oss_url") or None


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
                   WHERE (is_deleted IS NULL OR is_deleted = FALSE)"""
            params: list = []
            if category:
                q += " AND category = %s"
                params.append(category)
            q += " ORDER BY name"
            cur.execute(q, params)
            return [dict(r) for r in cur.fetchall()]
    finally:
        put_conn_for(ds, conn)


def _append_media(ds: str, char_id: int, url: str, media_type: str, source: str, extra: dict | None = None):
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


def _build_prompt(name: str, description, attributes) -> str:
    """Build a portrait-card prompt from the character's profile."""
    if isinstance(attributes, str):
        try:
            attributes = json.loads(attributes)
        except (json.JSONDecodeError, TypeError):
            attributes = {}
    attributes = attributes or {}

    # Core appearance
    age = attributes.get("Age", "")
    ethnicity = attributes.get("Ethnicity", "")
    body = attributes.get("Body", "")
    occupation = attributes.get("Occupation", "")
    personality = attributes.get("Personality", "")
    relationship = attributes.get("Relationship", "")

    # Determine gender hint from attributes/relationship/name patterns
    is_female = any(kw in (relationship + " " + occupation).lower()
                    for kw in ("girlfriend", "wife", "girl", "woman", "actress", "model"))
    is_male = any(kw in (relationship + " " + occupation).lower()
                  for kw in ("boyfriend", "husband", "boy", "man", "actor"))

    # Build subject with attractiveness emphasis
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

    lines = [
        f"solo, single person, professional portrait photo of {subject}",
        f"character: {name}",
        "beautiful detailed face, perfect facial features, flawless skin, attractive",
    ]
    if occupation:
        lines.append(f"occupation: {occupation}")
    if personality:
        vibe = personality.split(",")[0].strip().split(".")[0].strip()
        if vibe:
            lines.append(f"expression and vibe: {vibe}")

    desc = (description or "").strip()
    if desc:
        short_desc = desc[:200]
        lines.append(f"context: {short_desc}")

    lines.append(
        "solo portrait, upper body shot, looking at viewer, "
        "high quality, masterpiece, best quality, detailed, natural lighting, "
        "shallow depth of field, no other people, single subject only"
    )

    return ", ".join(lines)[:1500]


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
            return url
        if status == "FAILED":
            raise RuntimeError(out.get("task_message") or out.get("error_message") or "task failed")
    raise RuntimeError(f"timed out after {POLL_TIMEOUT}s")


async def _comfy(task_type: str, **kwargs) -> str:
    """Run one ComfyUI task in a thread (blocking) and return its public URL."""
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(
        None, lambda: comfyui_single.run_oneshot(task_type=task_type, **kwargs)
    )
    if not res.get("ok") or not res.get("url"):
        raise RuntimeError(res.get("error", "comfyui task failed"))
    return res["url"]


async def _gen_zimage(engine: str, prompt: str, w: int, h: int, seed: int) -> str:
    if engine == "comfyui":
        return await _comfy("comfy_zimage", prompt=prompt, seed=seed)
    return await _run_and_wait(smartstudio_client.create_zimage(prompt, w, h, seed))


async def _gen_imageedit(engine: str, image: str, prompt: str, seed: int) -> str:
    if engine == "comfyui":
        return await _comfy("comfy_edit", image_url=image, prompt=prompt, seed=seed)
    return await _run_and_wait(smartstudio_client.create_imageedit(image, prompt, seed))


async def _gen_faceswap(engine: str, body: str, face: str, seed: int) -> str:
    if engine == "comfyui":
        return await _comfy("comfy_swap", image_url=body, face_url=face, seed=seed)
    return await _run_and_wait(smartstudio_client.create_faceswap(body, face, seed))


async def _gen_video(engine: str, image: str, prompt: str, seed: int) -> str:
    if engine == "comfyui":
        return await _comfy("comfy_video", image_url=image, prompt=prompt, seed=seed)
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
            mats = await vfe_client.search_images(limit=per, offset=0)
            prompts = [it.get("prompt") for it in mats.get("items", []) if it.get("prompt")]
            for p in prompts[:per]:
                units.append({"char": ch, "prompt": p})

    elif btype == "imageedit":
        for ch in chars:
            if not ch.get("avatar_url"):
                continue
            mats = await vfe_client.search_images(limit=per, offset=0)
            prompts = [it.get("prompt") for it in mats.get("items", []) if it.get("prompt")]
            for p in prompts[:per]:
                units.append({"char": ch, "prompt": p, "base": ch["avatar_url"]})

    elif btype == "faceswap":
        for ch in chars:
            if not ch.get("avatar_url"):
                continue
            # swap_direct: body = VFE face_nsfw material
            mats = await vfe_client.get_faceswap_materials(limit=per)
            for it in mats.get("items", [])[:per]:
                body = _vfe_image_url(it)
                if body:
                    units.append({"char": ch, "face": ch["avatar_url"], "body": body, "origin": "swap_direct"})
            # swap_zimage: body generated by zimage from character prompt
            zp = _build_prompt(ch["name"], ch.get("description"), ch.get("attributes"))
            for _ in range(per):
                units.append({"char": ch, "face": ch["avatar_url"], "zimage_prompt": zp, "origin": "swap_zimage"})

    elif btype == "video":
        for ch in chars:
            media = _parse_media(ch.get("media"))
            frames = [
                m for m in media
                if isinstance(m, dict) and m.get("type") == "image"
                and m.get("source") in ("swap_direct", "swap_zimage", "imageedit")
                and m.get("url")
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

    elif btype == "avatar":
        for ch in chars:
            if ch.get("avatar_url"):
                continue  # already has an avatar -> skip
            media = _parse_media(ch.get("media"))
            first_img = next(
                (m["url"] for m in media
                 if isinstance(m, dict) and m.get("type") == "image"
                 and m.get("url") and not m.get("is_deleted")),
                None,
            )
            if first_img:
                units.append({"char": ch, "src_image": first_img})

    job["_meta"] = job_meta
    return units


async def _process_unit(ds: str, btype: str, unit: dict, seed: int, w: int, h: int, engine: str = "smartstudio"):
    ch = unit["char"]
    if btype == "anime":
        ep = unit.get("edit_prompt") or ANIME_EDIT_PROMPT
        base = await _gen_zimage(engine, unit["prompt"], w, h, seed)
        url = await _gen_imageedit(engine, base, ep, seed)
        _append_media(ds, ch["id"], url, "image", "zimage_anime",
                      {"prompt": unit["prompt"], "edit_prompt": ep, "engine": engine})

    elif btype == "anime_direct":
        url = await _gen_zimage(engine, unit["prompt"], w, h, seed)
        _append_media(ds, ch["id"], url, "image", "zimage_anime_direct",
                      {"prompt": unit["prompt"], "engine": engine})

    elif btype == "zimage":
        url = await _gen_zimage(engine, unit["prompt"], w, h, seed)
        _append_media(ds, ch["id"], url, "image", "zimage", {"prompt": unit["prompt"], "engine": engine})

    elif btype == "imageedit":
        url = await _gen_imageedit(engine, unit["base"], unit["prompt"], seed)
        _append_media(ds, ch["id"], url, "image", "imageedit", {"prompt": unit["prompt"], "engine": engine})

    elif btype == "faceswap":
        if unit["origin"] == "swap_zimage":
            body = await _gen_zimage(engine, unit["zimage_prompt"], w, h, seed)
        else:
            body = unit["body"]
        url = await _gen_faceswap(engine, body, unit["face"], seed)
        _append_media(ds, ch["id"], url, "image", unit["origin"], {"model_source": unit["origin"], "engine": engine})

    elif btype == "video":
        url = await _gen_video(engine, unit["frame"], unit["video_prompt"], seed)
        _append_media(ds, ch["id"], url, "video", f"video_{unit['frame_origin']}",
                      {"frame_origin": unit["frame_origin"], "video_prompt": unit["video_prompt"], "engine": engine})

    elif btype == "avatar":
        result = await avatar_service.generate_avatar(unit["src_image"])
        if not result.get("ok"):
            raise RuntimeError(result.get("error", "avatar generation failed"))
        _set_avatar(ds, ch["id"], result["avatar_url"])


# ----------------------------------------------------------------- worker
def _worker(job_id: str, ds: str):
    job = _jobs[job_id]
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    async def _run():
        with _lock:
            job["status"] = "building"
        units = await _build_units(job, ds)
        engine = job.get("engine", "smartstudio")
        # ComfyUI: parallelize across the whole local port pool. SmartStudio:
        # keep low to avoid 429. Avatar (local YOLO) uses the default.
        if job["type"] == "avatar":
            conc = CONCURRENCY
        elif engine == "comfyui":
            conc = len(comfyui_single.COMFYUI_PORTS)
        else:
            conc = CONCURRENCY
        with _lock:
            job["total"] = len(units)
            job["status"] = "running"

        sem = asyncio.Semaphore(conc)

        async def _one(unit):
            async with sem:
                with _lock:
                    if job["status"] == "stopping":
                        return
                    job["current"] = unit["char"]["name"]
                try:
                    await _process_unit(ds, job["type"], unit, job["seed"], job["width"], job["height"], engine)
                    with _lock:
                        job["succeeded"] += 1
                except Exception as e:
                    with _lock:
                        job["failed"] += 1
                        job["results"].append({
                            "char": unit["char"]["name"], "ok": False, "error": str(e)[:200],
                        })
                finally:
                    with _lock:
                        job["processed"] += 1

        await asyncio.gather(*[_one(u) for u in units])

    try:
        loop.run_until_complete(_run())
        with _lock:
            job["status"] = "stopped" if job["status"] == "stopping" else "completed"
            job["current"] = None
            job["finished_at"] = datetime.now(timezone.utc).isoformat()
    except Exception as e:
        with _lock:
            job["status"] = "error"
            job["error"] = str(e)[:300]
    finally:
        loop.close()


# ----------------------------------------------------------------- public API
VALID_TYPES = {"anime", "anime_direct", "faceswap", "zimage", "imageedit", "video", "avatar"}


def start_job(ds: str, btype: str, per_character: int = 10, category: str | None = None,
              width: int = 1024, height: int = 1536, seed: int = 0,
              edit_prompt: str | None = None, engine: str = "smartstudio") -> dict:
    global _current_job_id
    if btype not in VALID_TYPES:
        return {"status": "error", "message": f"未知批处理类型: {btype}"}
    if engine not in ("smartstudio", "comfyui"):
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
            "status": "starting", "total": 0, "processed": 0,
            "succeeded": 0, "failed": 0, "current": None,
            "results": [], "error": None,
            "started_at": datetime.now(timezone.utc).isoformat(), "finished_at": None,
        }
        _current_job_id = job_id
    threading.Thread(target=_worker, args=(job_id, ds), daemon=True).start()
    return {"status": "ok", "job_id": job_id}


def get_job(job_id: str | None = None) -> dict | None:
    with _lock:
        jid = job_id or _current_job_id
        if not jid:
            return None
        job = _jobs.get(jid)
        if not job:
            return None
        out = {k: v for k, v in job.items() if not k.startswith("_")}
        return out


def stop_job(job_id: str | None = None) -> dict:
    with _lock:
        jid = job_id or _current_job_id
        job = _jobs.get(jid) if jid else None
        if not job:
            return {"status": "error", "message": "任务不存在"}
        if job["status"] in ("running", "starting", "building"):
            job["status"] = "stopping"
            return {"status": "ok", "message": "正在停止"}
        return {"status": "ok", "message": f"任务已是 {job['status']}"}
