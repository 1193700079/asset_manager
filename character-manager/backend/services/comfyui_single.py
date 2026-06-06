"""
Single-task ComfyUI processing — extracted from batch scripts.

Supports 4 workflow types:
  - comfy_swap:     Face swap (body + face → output image)
  - comfy_zimage:   Text-to-image (prompt → output image)
  - comfy_edit:     Image edit (image + prompt → output image)
  - comfy_video:    Image-to-video (image + prompt → output video)
"""
import copy
import json
import random
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

import requests

# ── Workflow paths ────────────────────────────────
WORKFLOW_SWAP = "/mnt/cypher/project/asset_manager/换脸生视频工作流.json"
WORKFLOW_ZIMAGE = "/mnt/user/joseph/data/ScrapedData/Z-Image+Base+&+Turbo+双重采样工作流-cypher (2).json"
WORKFLOW_EDIT = "/mnt/user/joseph/data/ScrapedData/Joseph-qwen-image-edit (3).json"
WORKFLOW_VIDEO = "/mnt/cypher/project/asset_manager/Vantage-Sulphur-2-Workflow.json"

# ── ComfyUI ports ─────────────────────────────────
# 16-proc layout: 8 GPUs × 2 slots each
#   slot 0: 8188-8195
#   slot 1: 8288-8295
COMFYUI_PORTS = [
    8188, 8189, 8190, 8191, 8192, 8193, 8194, 8195,
    8288, 8289, 8290, 8291, 8292, 8293, 8294, 8295,
]
COMFYUI_HOST = "localhost"

# ── Node IDs per workflow ─────────────────────────
# Swap (batch_swap_v2.py)
SWAP_NODE_BODY = "39"
SWAP_NODE_FACE = "40"
SWAP_NODE_SEED = "23"
SWAP_NODE_W1 = "30"
SWAP_NODE_W2 = "31"

# ZImage (batch_z-image_generate.py)
ZIMG_NODE_POS = "47"
ZIMG_NODE_NEG = "7"
ZIMG_NODE_SEED = "43"
ZIMG_NODE_FILE = "35"

# Edit (batch-edit.py)
EDIT_NODE_IMAGE = "18"
EDIT_NODE_PROMPT = "17"
EDIT_NODE_SEED = "16"
EDIT_NODE_FILE = "10"

# Video (batch-video.py)
VID_NODE_IMAGE = "255"
VID_NODE_PROMPT = "393"
VID_NODE_SEED = "259"
VID_NODE_FILE = "327"

# ── Output dir for results ────────────────────────
OUTPUT_DIR = Path("/mnt/cypher/project/asset_manager/character-manager/backend/logs/comfyui_output")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ── State ─────────────────────────────────────────
_lock = threading.Lock()
_jobs: dict[str, dict] = {}
_workflow_cache: dict[str, dict] = {}
_wf_lock = threading.Lock()

WORKFLOW_MAP = {
    "comfy_swap": WORKFLOW_SWAP,
    "comfy_zimage": WORKFLOW_ZIMAGE,
    "comfy_edit": WORKFLOW_EDIT,
    "comfy_video": WORKFLOW_VIDEO,
}

WORKFLOW_LABELS = {
    "comfy_swap": "ComfyUI 换脸",
    "comfy_zimage": "ComfyUI 文生图 (ZImage)",
    "comfy_edit": "ComfyUI 图片编辑",
    "comfy_video": "ComfyUI 图生视频 (LTX)",
}


def _load_workflow(wf_type: str) -> dict:
    with _wf_lock:
        if wf_type not in _workflow_cache:
            path = WORKFLOW_MAP.get(wf_type)
            if not path or not Path(path).exists():
                raise FileNotFoundError(f"Workflow not found: {wf_type} -> {path}")
            with open(path, "r", encoding="utf-8") as f:
                _workflow_cache[wf_type] = json.load(f)
        return copy.deepcopy(_workflow_cache[wf_type])


def _round_to(x: float, step: int) -> int:
    """Round float x to the nearest multiple of step."""
    return int(round(x / step) * step)


def _find_free_port() -> Optional[int]:
    """Find a ComfyUI port with smallest queue."""
    best_port, best_size = None, float("inf")
    for port in COMFYUI_PORTS:
        try:
            r = requests.get(f"http://{COMFYUI_HOST}:{port}/queue", timeout=5)
            if r.status_code == 200:
                data = r.json()
                size = len(data.get("queue_running", [])) + len(data.get("queue_pending", []))
                if size < best_size:
                    best_size = size
                    best_port = port
        except Exception:
            pass
    return best_port


def _upload_image(port: int, image_url: str, filename: str) -> str:
    """Download image from URL and upload to ComfyUI. If URL is local path, read directly."""
    if image_url.startswith("http://") or image_url.startswith("https://"):
        resp = requests.get(image_url, timeout=30)
        resp.raise_for_status()
        data = resp.content
    elif Path(image_url).exists():
        data = Path(image_url).read_bytes()
        filename = Path(image_url).name
    else:
        raise FileNotFoundError(f"Image not accessible: {image_url}")

    ext = Path(filename).suffix.lower() or ".png"
    mime = "image/png" if ext == ".png" else "image/jpeg"
    upload_resp = requests.post(
        f"http://{COMFYUI_HOST}:{port}/upload/image",
        files={"image": (filename, data, mime)},
        timeout=30,
    )
    upload_resp.raise_for_status()
    return upload_resp.json()["name"]


def _submit_and_poll(port: int, workflow: dict, task_type: str, timeout: int = 600) -> dict:
    """Submit workflow and poll until done. Returns {result_url, error, ...}."""
    import time as _time
    
    client_id = str(uuid.uuid4())
    
    _t0 = _time.time()
    resp = requests.post(
        f"http://{COMFYUI_HOST}:{port}/prompt",
        json={"prompt": workflow, "client_id": client_id},
        timeout=30,
    )
    _t_submit = _time.time() - _t0
    
    if resp.status_code != 200:
        # Capture ComfyUI error details
        try:
            error_data = resp.json()
            error_msg = error_data.get("error", {}).get("message", "") or str(error_data)
        except:
            error_msg = resp.text[:500]
        return {"status": "failed", "error": f"ComfyUI {resp.status_code}: {error_msg}"}
    
    prompt_id = resp.json()["prompt_id"]
    print(f"[comfyui] submit took {_t_submit:.2f}s, prompt_id={prompt_id[:8]}")

    start = time.time()
    poll_count = 0
    while time.time() - start < timeout:
        poll_count += 1
        try:
            h = requests.get(f"http://{COMFYUI_HOST}:{port}/history/{prompt_id}", timeout=15)
            if h.status_code == 200:
                history = h.json().get(prompt_id)
                if history:
                    status = history.get("status", {})
                    if status.get("completed"):
                        _t_total = _time.time() - start
                        print(f"[comfyui] completed in {_t_total:.1f}s after {poll_count} polls")
                        # Extract output files
                        files = []
                        for node_id, node_out in history.get("outputs", {}).items():
                            for key in ("images", "gifs", "videos"):
                                for item in node_out.get(key, []):
                                    files.append({
                                        "filename": item.get("filename", ""),
                                        "subfolder": item.get("subfolder", ""),
                                        "type": item.get("type", "output"),
                                    })
                        # Download first file to local + return URL
                        if files:
                            return {"prompt_id": prompt_id, "port": port, "files": files, "status": "completed"}
                        return {"prompt_id": prompt_id, "port": port, "files": [], "status": "completed", "error": "No output files"}
                    if status.get("status_str") == "error":
                        msgs = status.get("messages", [])
                        err = str(msgs[-1]) if msgs else "Unknown error"
                        return {"prompt_id": prompt_id, "port": port, "status": "failed", "error": err}
        except Exception:
            pass
        time.sleep(3)

    return {"prompt_id": prompt_id, "port": port, "status": "failed", "error": f"Timeout ({timeout}s)"}


def _download_result(port: int, file_info: dict, job_id: str) -> str:
    """Download a result file from ComfyUI and return local path."""
    params = {
        "filename": file_info["filename"],
        "subfolder": file_info.get("subfolder", ""),
        "type": file_info.get("type", "output"),
    }
    resp = requests.get(f"http://{COMFYUI_HOST}:{port}/view", params=params, timeout=30)
    resp.raise_for_status()

    out_dir = OUTPUT_DIR / job_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / file_info["filename"]
    out_path.write_bytes(resp.content)
    return str(out_path)


# ── Public API ────────────────────────────────────

def _next_job_id() -> str:
    with _lock:
        return f"cui-{int(time.time())}-{random.randint(1000,9999)}"


def list_comfyui_scripts() -> list[dict]:
    return [
        {"key": "comfy_swap", "label": WORKFLOW_LABELS["comfy_swap"],
         "category": "image", "needs_image": True, "needs_face": True, "needs_prompt": False,
         "description": "换脸: body + face → 输出图片"},
        {"key": "comfy_zimage", "label": WORKFLOW_LABELS["comfy_zimage"],
         "category": "image", "needs_image": False, "needs_face": False, "needs_prompt": True,
         "description": "文生图: prompt → 输出图片"},
        {"key": "comfy_edit", "label": WORKFLOW_LABELS["comfy_edit"],
         "category": "image", "needs_image": True, "needs_face": False, "needs_prompt": True,
         "description": "图片编辑: image + prompt → 输出图片"},
        {"key": "comfy_video", "label": WORKFLOW_LABELS["comfy_video"],
         "category": "video", "needs_image": True, "needs_face": False, "needs_prompt": True,
         "description": "图生视频: image + prompt → 输出视频"},
    ]


def submit_single(task_type: str, image_url: str = "", face_url: str = "",
                  prompt: str = "", seed: int = 0, character_name: str = "") -> dict:
    """Submit a single ComfyUI task. Runs in background thread. Returns job info."""
    if task_type not in WORKFLOW_LABELS:
        return {"status": "error", "message": f"Unknown type: {task_type}"}

    job_id = _next_job_id()
    if seed == 0:
        seed = random.randint(0, 2**31 - 1)

    job = {
        "job_id": job_id,
        "task_type": task_type,
        "label": WORKFLOW_LABELS[task_type],
        "character_name": character_name,
        "image_url": image_url,
        "face_url": face_url,
        "prompt": prompt,
        "seed": seed,
        "status": "running",
        "result_url": None,
        "result_path": None,
        "error": None,
        "port": None,
        "prompt_id": None,
        "created_at": datetime.now().isoformat(),
        "completed_at": None,
    }

    with _lock:
        _jobs[job_id] = job

    threading.Thread(target=_run_single, args=(job_id, task_type, image_url, face_url, prompt, seed), daemon=True).start()

    return {"status": "ok", "job_id": job_id}


def _run_single(job_id: str, task_type: str, image_url: str, face_url: str, prompt: str, seed: int):
    """Background worker for single task processing."""
    import time as _time
    _t_start = _time.time()
    
    try:
        # 1. Find free port
        _t0 = _time.time()
        port = _find_free_port()
        _t_find_port = _time.time() - _t0
        print(f"[comfyui] find_free_port took {_t_find_port:.2f}s")
        
        if port is None:
            _update_job(job_id, status="failed", error="No available ComfyUI instance")
            return
        _update_job(job_id, port=port)

        # 2. Load workflow
        _t0 = _time.time()
        wf = _load_workflow(task_type)
        _t_load_wf = _time.time() - _t0
        print(f"[comfyui] load_workflow took {_t_load_wf:.2f}s")

        # 3. Upload images & inject params
        if task_type == "comfy_swap":
            if not image_url or not face_url:
                _update_job(job_id, status="failed", error="Swap needs both image_url and face_url")
                return
            body_name = _upload_image(port, image_url, "body.png")
            face_name = _upload_image(port, face_url, "face.png")
            wf[SWAP_NODE_BODY]["inputs"]["image"] = body_name
            wf[SWAP_NODE_FACE]["inputs"]["image"] = face_name
            wf[SWAP_NODE_SEED]["inputs"]["noise_seed"] = seed

        elif task_type == "comfy_zimage":
            if not prompt:
                _update_job(job_id, status="failed", error="ZImage needs a prompt")
                return
            wf[ZIMG_NODE_POS]["inputs"]["text"] = prompt
            wf[ZIMG_NODE_NEG]["inputs"]["text"] = "blurry, ugly, bad anatomy, deformed, low quality"
            wf[ZIMG_NODE_SEED]["inputs"]["seed"] = seed
            wf[ZIMG_NODE_FILE]["inputs"]["filename_prefix"] = f"single/zimg_{job_id}"
            
            # Set resolution to 720p (720x1280 for portrait)
            if "10" in wf and wf["10"].get("class_type") == "EmptyLatentImage":
                wf["10"]["inputs"]["width"] = 720
                wf["10"]["inputs"]["height"] = 1280

        elif task_type == "comfy_edit":
            if not image_url or not prompt:
                _update_job(job_id, status="failed", error="Edit needs image_url and prompt")
                return

            _t0 = time.time()
            img_name = _upload_image(port, image_url, "edit_input.png")
            _t_upload = time.time() - _t0
            print(f"[comfyui-edit] image upload took {_t_upload:.2f}s")

            # Compute target_size to match source image pixel area (~ preserve resolution 1:1).
            # The QwenEdit node scales to total_pixels = target_size²; aspect ratio follows source.
            import math as _math
            try:
                if image_url.startswith(("http://", "https://")):
                    _hreq = requests.head(image_url, timeout=10, allow_redirects=True)
                    _ctype = _hreq.headers.get("Content-Type", "")
                    if "svg" not in _ctype and "json" not in _ctype:
                        from PIL import Image as _PILImage
                        import io as _io
                        _body = requests.get(image_url, timeout=30).content
                        with _PILImage.open(_io.BytesIO(_body)) as _img_tmp:
                            _src_w, _src_h = _img_tmp.size
                    else:
                        _src_w, _src_h = 1024, 1024
                elif Path(image_url).exists():
                    from PIL import Image as _PILImage
                    with _PILImage.open(image_url) as _img_tmp:
                        _src_w, _src_h = _img_tmp.size
                else:
                    _src_w, _src_h = 1024, 1024
                _raw_ts = _math.sqrt(_src_w * _src_h)
                _target_size = int(max(512, min(2048, _round_to(_raw_ts, 8))))
                print(f"[comfyui-edit] source={_src_w}x{_src_h} -> target_size={_target_size}")
            except Exception as _e:
                print(f"[comfyui-edit] resolution probe failed ({_e}), defaulting to 1024")
                _target_size = 1024

            wf[EDIT_NODE_IMAGE]["inputs"]["image"] = img_name
            
            # Node 17: TextEncodeQwenImageEditPlusAdvance
            wf[EDIT_NODE_PROMPT]["inputs"]["prompt"] = prompt
            wf[EDIT_NODE_PROMPT]["inputs"]["instruction"] = (
                "Describe the key features of the input image (color, shape, size, texture, objects, background), "
                "then explain how the user's text instruction should alter or modify the image. "
                "Generate a new image that meets the user's requirements while maintaining consistency "
                "with the original input where appropriate. "
                "Keep the subject's facial features, face shape, bone structure, and identity identical to the input image. "
                "Avoid: overly smooth skin, plastic skin, waxy skin, shiny plastic, artificial lighting, "
                "harsh shadows, cartoon, 3d render, anime, painting, illustration, blurry, "
                "low quality, deformed, extra limbs, bad anatomy."
            )
            # Allowed target_size values for TextEncodeQwenImageEditPlusAdvance:
            # [1024, 1344, 1536, 2048, 768, 512]. Use 1024 as a safe default.
            wf[EDIT_NODE_PROMPT]["inputs"]["target_size"] = _target_size
            # Explicit connections from CheckpointLoaderSimple (node 15)
            wf[EDIT_NODE_PROMPT]["inputs"]["clip"] = ["15", 1]
            wf[EDIT_NODE_PROMPT]["inputs"]["vae"] = ["15", 2]
            
            # Node 13: KSampler - explicit model connection
            wf["13"]["inputs"]["model"] = ["15", 0]
            
            # Node 11: VAEDecode - explicit vae connection
            wf["11"]["inputs"]["vae"] = ["15", 2]

            # Post-process: resize the square QwenEdit output back to source resolution.
            # The QwenImageEdit node always produces square output (target_size × target_size)
            # due to how its reference latent is VAE-encoded. We insert a built-in ImageScale
            # between VAEDecode (node 11) and SaveImage (node 10) so the final image
            # matches the source image's native width × height.
            if _src_w and _src_h and (_src_w != _src_h):
                wf["99"] = {
                    "inputs": {
                        "image": ["11", 0],
                        "upscale_method": "lanczos",
                        "width": _src_w,
                        "height": _src_h,
                        "crop": "disabled",
                    },
                    "class_type": "ImageScale",
                    "_meta": {"title": "ImageScale back to source"},
                }
                wf["10"]["inputs"]["images"] = ["99", 0]
                print(f"[comfyui-edit] will resize square output → {_src_w}x{_src_h}")
            
            # Disable Anything Everywhere (node 7) to avoid injection conflicts
            if "7" in wf:
                wf["7"]["inputs"] = {}
            
            # Node 14: Replace custom LayerUtility with built-in ImageScale
            # Original node 14 scaled to 512 with aspect ratio, we'll use built-in ImageScale
            wf["14"] = {
                "inputs": {
                    "image": ["18", 0],
                    "upscale_method": "lanczos",
                    "width": 512,
                    "height": 512,
                    "crop": "disabled"
                },
                "class_type": "ImageScale",
                "_meta": {"title": "ImageScale"}
            }
            
            # Node 16: Seed
            wf[EDIT_NODE_SEED]["inputs"]["seed"] = seed
            
            # Node 10: SaveImage
            wf[EDIT_NODE_FILE]["inputs"]["filename_prefix"] = f"single/edit_{job_id}"

        elif task_type == "comfy_video":
            if not image_url:
                _update_job(job_id, status="failed", error="Video needs image_url")
                return
            img_name = _upload_image(port, image_url, "vid_input.png")
            wf[VID_NODE_IMAGE]["inputs"]["image"] = img_name
            if prompt:
                wf[VID_NODE_PROMPT]["inputs"]["value"] = prompt
            wf[VID_NODE_SEED]["inputs"]["noise_seed"] = seed
            wf[VID_NODE_FILE]["inputs"]["filename_prefix"] = f"single/vid_{job_id}"

        # 4. Submit and poll
        result = _submit_and_poll(port, wf, task_type, timeout=600)
        if result["status"] == "failed":
            _update_job(job_id, status="failed", error=result.get("error", "Unknown"),
                        prompt_id=result.get("prompt_id"))
            return

        # 5. Download result
        _t0 = time.time()
        files = result.get("files", [])
        if not files:
            _update_job(job_id, status="failed", error="No output files",
                        prompt_id=result.get("prompt_id"))
            return

        local_path = _download_result(port, files[0], job_id)
        _t_download = time.time() - _t0
        print(f"[comfyui] result download took {_t_download:.2f}s")

        # 6. Build result URL (serve via FastAPI static files or VFE)
        result_url = f"/api/comfyui/result/{job_id}/{files[0]['filename']}"

        _update_job(job_id, status="completed",
                    result_url=result_url, result_path=local_path,
                    prompt_id=result.get("prompt_id"))
        
        _t_total = _time.time() - _t_start
        print(f"[comfyui] total workflow took {_t_total:.1f}s for {task_type}")

    except Exception as e:
        _update_job(job_id, status="failed", error=str(e)[:500])


def _update_job(job_id: str, **kwargs):
    with _lock:
        if job_id in _jobs:
            _jobs[job_id].update(kwargs)
            if kwargs.get("status") in ("completed", "failed"):
                _jobs[job_id]["completed_at"] = datetime.now().isoformat()


def get_single_job(job_id: str) -> Optional[dict]:
    with _lock:
        job = _jobs.get(job_id)
    if not job:
        return None
    return {k: v for k, v in job.items() if not k.startswith("_")}


def list_single_jobs(character_name: str = None) -> list[dict]:
    with _lock:
        jobs = list(_jobs.values())
    if character_name:
        jobs = [j for j in jobs if j.get("character_name") == character_name]
    return [
        {k: v for k, v in sorted(j.items(), key=lambda x: x[0]) if not k.startswith("_")}
        for j in sorted(jobs, key=lambda x: x.get("created_at", ""), reverse=True)[:20]
    ]


def get_result_file(job_id: str, filename: str) -> Optional[str]:
    """Return the local file path for a result."""
    path = OUTPUT_DIR / job_id / filename
    if path.exists():
        return str(path)
    return None


def discard_job(job_id: str) -> dict:
    """Mark a ComfyUI job as discarded."""
    with _lock:
        if job_id not in _jobs:
            return {"status": "error", "message": "Job not found"}
        _jobs[job_id]["status"] = "discarded"
        _jobs[job_id]["completed_at"] = datetime.now().isoformat()
    return {"status": "ok", "job_id": job_id}


def save_result_to_character(job_id: str, character_name: str, media_type: str = "image") -> dict:
    """Save a completed ComfyUI job's result into the character's media JSON array."""
    import json as _json
    import psycopg2.extras
    import oss2
    from pathlib import Path
    from config import settings

    # This import is deferred to avoid circular imports at module level
    from database import get_conn, put_conn

    with _lock:
        job = _jobs.get(job_id)

    if not job:
        return {"status": "error", "message": "Job not found"}
    if job.get("status") != "completed":
        return {"status": "error", "message": f"Job is {job.get('status')}, not completed"}
    if not job.get("result_url"):
        return {"status": "error", "message": "No result URL"}

    result_url = job["result_url"]
    task_type = job.get("task_type", "")

    if task_type in ("comfy_video",):
        media_type = "video"

    # Upload to OSS first
    result_path = job.get("result_path")
    if result_path and Path(result_path).exists():
        try:
            auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)
            bucket = oss2.Bucket(auth, settings.oss_endpoint, settings.oss_bucket)
            
            filename = Path(result_path).name
            oss_key = f"{settings.oss_prefix}{job_id}/{filename}"
            
            bucket.put_object_from_file(oss_key, result_path)
            
            # Build OSS URL
            endpoint = settings.oss_endpoint.replace("https://", "").replace("http://", "")
            oss_url = f"https://{settings.oss_bucket}.{endpoint}/{oss_key}"
            
            print(f"[comfyui] uploaded to OSS: {oss_url}")
            result_url = oss_url
        except Exception as e:
            print(f"[comfyui] OSS upload failed: {e}, using local URL")

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT id, media FROM characters WHERE name = %s", (character_name,))
            row = cur.fetchone()
            if not row:
                return {"status": "error", "message": f"Character '{character_name}' not found"}

            char_id = row["id"]
            media_raw = row["media"]
            if isinstance(media_raw, str):
                try:
                    media_list = _json.loads(media_raw)
                except Exception:
                    media_list = []
            elif isinstance(media_raw, list):
                media_list = media_raw
            else:
                media_list = []

            new_item = {
                "url": result_url,
                "type": media_type,
                "source": "comfyui_single",
                "task_type": task_type,
                "job_id": job_id,
                "created_at": datetime.now().isoformat(),
            }
            media_list.append(new_item)

            with conn.cursor() as cur2:
                cur2.execute(
                    "UPDATE characters SET media = %s::json WHERE id = %s",
                    (_json.dumps(media_list), char_id),
                )
            conn.commit()

        # Mark job as saved in memory
        _update_job(job_id, status="saved")

        return {"status": "ok", "media_type": media_type, "character": character_name}
    except Exception as e:
        conn.rollback()
        return {"status": "error", "message": str(e)[:500]}
    finally:
        put_conn(conn)


def _upload_to_oss(local_path: str, job_id: str) -> str | None:
    """Upload a local result file to OSS and return its public URL, or None."""
    try:
        import oss2
        from pathlib import Path as _Path
        from config import settings
        auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)
        bucket = oss2.Bucket(auth, settings.oss_endpoint, settings.oss_bucket)
        filename = _Path(local_path).name
        oss_key = f"{settings.oss_prefix}{job_id}/{filename}"
        bucket.put_object_from_file(oss_key, local_path)
        endpoint = settings.oss_endpoint.replace("https://", "").replace("http://", "")
        return f"https://{settings.oss_bucket}.{endpoint}/{oss_key}"
    except Exception as e:
        print(f"[comfyui] OSS upload failed: {e}")
        return None


def run_oneshot(task_type: str, image_url: str = "", face_url: str = "",
                prompt: str = "", seed: int = 0) -> dict:
    """Synchronously run ONE ComfyUI task across the 16-port pool and return a
    public OSS URL. Blocking — call from a thread executor for concurrency.

    task_type: comfy_swap | comfy_zimage | comfy_edit | comfy_video
    Returns {ok: True, url, local_path} or {ok: False, error}.
    """
    if task_type not in WORKFLOW_LABELS:
        return {"ok": False, "error": f"Unknown comfy task type: {task_type}"}
    if seed == 0:
        seed = random.randint(0, 2**31 - 1)

    job_id = _next_job_id()
    with _lock:
        _jobs[job_id] = {
            "job_id": job_id, "task_type": task_type, "label": WORKFLOW_LABELS[task_type],
            "character_name": "", "image_url": image_url, "face_url": face_url,
            "prompt": prompt, "seed": seed, "status": "running",
            "result_url": None, "result_path": None, "error": None,
            "port": None, "prompt_id": None,
            "created_at": datetime.now().isoformat(), "completed_at": None,
        }

    # Reuse the existing per-task worker synchronously.
    _run_single(job_id, task_type, image_url, face_url, prompt, seed)

    with _lock:
        job = dict(_jobs.get(job_id) or {})

    if job.get("status") != "completed" or not job.get("result_path"):
        return {"ok": False, "error": job.get("error") or "comfy task failed"}

    public_url = _upload_to_oss(job["result_path"], job_id)
    if not public_url:
        # Fall back to local serve URL (works within the same host).
        public_url = job.get("result_url")
    return {"ok": True, "url": public_url, "local_path": job.get("result_path")}
