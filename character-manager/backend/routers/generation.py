"""Generation router — per-character AI asset creation via SmartStudio APIs.

Endpoints:
  POST /api/generation/create          — Submit batch generation tasks
  GET  /api/generation/tasks/{char_id} — List generation tasks for a character
  GET  /api/generation/status/{task_id}— Poll SmartStudio and sync DB
  POST /api/generation/save/{task_id}  — Save result to character's media JSON
  POST /api/generation/discard/{task_id} — Mark task as discarded
  POST /api/generation/random-cards    — Random VFE cards as source material
  POST /api/generation/batch-save      — Batch save multiple tasks at once
  POST /api/generation/batch-discard   — Batch discard multiple tasks
"""
import json
import os
import re
import random
from datetime import datetime, timezone
from fastapi import APIRouter
from pydantic import BaseModel
import psycopg2.extras
from database import get_conn, put_conn, get_data_source
from services import smartstudio_client, batch_processing

router = APIRouter(prefix="/api/generation", tags=["generation"])

# Transient error patterns that SmartStudio may return temporarily.
# When these occur within the grace period, we keep polling instead of marking failed.
_TRANSIENT_ERROR_PATTERNS = [
    "Unknown task type",
    "Service temporarily unavailable",
    "Internal server error",
]
_TRANSIENT_GRACE_SECONDS = 60  # Keep retrying for up to 60s after task creation

# -- Media generation_tasks schema (actual DB columns):
#    id (varchar PK = smartstudio task_id)
#    user_id (varchar NOT NULL)
#    character_id (int NOT NULL)
#    character_name (varchar NOT NULL)
#    task_type (varchar NOT NULL)
#    status (varchar NOT NULL)
#    prompt (text NOT NULL)
#    final_prompt (text NOT NULL)
#    ref_image_url (varchar NOT NULL)
#    n, model, model_level (nullable)
#    resolution, duration (nullable)
#    result_url, error (nullable)
#    created_at, updated_at (timestamptz)
#    priority (int default 0)

USER_ID = "character-manager"


def _parse_json(val):
    if val is None:
        return None
    if isinstance(val, (list, dict)):
        return val
    try:
        return json.loads(val)
    except (json.JSONDecodeError, TypeError):
        return None


# ---------- Request models ----------

class CreateGenerationRequest(BaseModel):
    character_id: int
    character_name: str
    task_type: str  # faceswap | zimage | wan_spicy | wan_animate
    source_image: str = ""
    face_image: str = ""
    prompt: str = ""
    width: int = 1024
    height: int = 1536
    duration: int = 5
    resolution: str = "480p"
    seed: int = 0
    batch_count: int = 1


class SaveGenerationRequest(BaseModel):
    media_type: str  # image | video


class BatchActionRequest(BaseModel):
    task_ids: list[str]


class RandomCardsRequest(BaseModel):
    character_id: int
    count: int = 10
    exclude_paths: list[str] = []


class BatchGenerateRequest(BaseModel):
    type: str  # faceswap | zimage | imageedit | video | anime
    per_character: int = 10
    category: str | None = None
    width: int = 1024
    height: int = 1536
    seed: int = 0
    edit_prompt: str | None = None
    engine: str = "smartstudio"  # smartstudio | comfyui | dashscope
    overwrite: bool = False


# ---------- Endpoints ----------

def _is_valid_url(url: str) -> bool:
    """Check if a string is a valid HTTP(S) URL."""
    return bool(url and re.match(r'^https?://.+', url.strip()))


@router.post("/create")
async def create_generation(data: CreateGenerationRequest):
    """Submit a batch of generation tasks to SmartStudio."""
    # ── Parameter validation ──
    if data.task_type == "imageedit":
        if not _is_valid_url(data.source_image):
            return {
                "status": "error",
                "task_ids": [],
                "errors": ["图像编辑任务需要提供有效的源图片URL (source_image)"],
            }
        if not data.prompt.strip():
            return {
                "status": "error",
                "task_ids": [],
                "errors": ["图像编辑任务需要提供编辑提示词 (prompt)"],
            }
    elif data.task_type == "faceswap":
        if not _is_valid_url(data.face_image):
            return {
                "status": "error",
                "task_ids": [],
                "errors": ["换脸任务需要提供有效的人脸图片URL (face_image)"],
            }
        if not _is_valid_url(data.source_image):
            return {
                "status": "error",
                "task_ids": [],
                "errors": ["换脸任务需要提供有效的源图片URL (source_image)"],
            }
    elif data.task_type in ("wan_spicy", "wan_animate"):
        if not _is_valid_url(data.source_image):
            return {
                "status": "error",
                "task_ids": [],
                "errors": ["视频生成任务需要提供有效的源图片URL (source_image)"],
            }
    elif data.task_type == "zimage":
        if not data.prompt.strip():
            return {
                "status": "error",
                "task_ids": [],
                "errors": ["文生图任务需要提供提示词 (prompt)"],
            }

    batch_count = max(1, min(data.batch_count, 10))
    task_ids: list[str] = []
    errors: list[str] = []

    conn = get_conn()
    try:
        for _ in range(batch_count):
            # Call appropriate SmartStudio API
            try:
                if data.task_type == "faceswap":
                    tid = await smartstudio_client.create_faceswap(
                        data.source_image, data.face_image, data.seed,
                    )
                elif data.task_type == "zimage":
                    import time as _time
                    print(f"[DEBUG create] {_time.time():.3f} zimage params: prompt={data.prompt[:50]}, width={data.width}, height={data.height}, seed={data.seed}")
                    tid = await smartstudio_client.create_zimage(
                        data.prompt, data.width, data.height, data.seed,
                    )
                    print(f"[DEBUG create] {_time.time():.3f} zimage returned task_id: {tid}")
                elif data.task_type == "imageedit":
                    tid = await smartstudio_client.create_imageedit(
                        data.source_image, data.prompt, data.seed,
                    )
                elif data.task_type == "wan_spicy":
                    tid = await smartstudio_client.create_wan_spicy(
                        data.source_image, data.prompt, data.duration,
                        data.resolution, data.seed,
                    )
                elif data.task_type == "wan_animate":
                    tid = await smartstudio_client.create_wan_animate(
                        data.source_image, data.source_image,
                        data.resolution, data.prompt, data.seed,
                    )
                else:
                    errors.append(f"Unknown task_type: {data.task_type}")
                    continue
            except Exception as e:
                errors.append(str(e))
                continue

            # Insert into media_generation_tasks
            ref_url = data.source_image or data.face_image or ""
            import time as _time
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO media_generation_tasks
                       (id, user_id, character_id, character_name, task_type,
                        status, prompt, final_prompt, ref_image_url,
                        resolution, duration, priority)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (
                        tid,                    # id = SmartStudio task_id
                        USER_ID,                # user_id
                        data.character_id,
                        data.character_name,
                        data.task_type,
                        "pending",              # status
                        data.prompt,            # prompt
                        data.prompt,            # final_prompt (same for now)
                        ref_url,                # ref_image_url
                        data.resolution,
                        data.duration,
                        0,                      # priority
                    ),
                )
                print(f"[DEBUG create] {_time.time():.3f} INSERT task_id={tid} status=pending")
            conn.commit()
            print(f"[DEBUG create] {_time.time():.3f} COMMIT task_id={tid}")
            task_ids.append(tid)

        return {
            "status": "ok" if task_ids else "error",
            "task_ids": task_ids,
            "errors": errors,
        }
    finally:
        put_conn(conn)


@router.get("/tasks/{character_id}")
async def list_tasks(character_id: int):
    """List all generation tasks for a character."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT id as task_id, character_id, character_name, task_type,
                          status, prompt, ref_image_url, resolution, duration,
                          result_url, error, created_at, updated_at
                   FROM media_generation_tasks
                   WHERE character_id = %s
                   ORDER BY created_at DESC""",
                (character_id,),
            )
            rows = cur.fetchall()

        tasks = []
        for r in rows:
            tasks.append({
                "task_id": r["task_id"],
                "character_id": r["character_id"],
                "character_name": r["character_name"],
                "task_type": r["task_type"],
                "status": r["status"],
                "prompt": r["prompt"],
                "ref_image_url": r["ref_image_url"],
                "resolution": r["resolution"],
                "duration": r["duration"],
                "result_url": r["result_url"],
                "error": r["error"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
            })
        return {"status": "ok", "tasks": tasks}
    finally:
        put_conn(conn)


@router.get("/status/{task_id}")
async def poll_status(task_id: str):
    """Poll SmartStudio for task status and sync DB."""
    import sys
    print(f"===== POLL_STATUS CALLED for {task_id} (pid={os.getpid()}) =====", file=sys.stderr, flush=True)
    conn = get_conn()
    try:
        # Check if task exists and if it's stuck (running > 120s)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT status, updated_at, result_url, error, created_at FROM media_generation_tasks WHERE id = %s",
                (task_id,),
            )
            existing = cur.fetchone()
            if not existing:
                return {"status": "error", "message": "Task not found", "task_status": "NOT_FOUND"}
            
            import time as _time
            print(f"[DEBUG poll_status] {_time.time():.3f} task_id={task_id}, existing_status={existing['status']}, existing_error={existing.get('error')}")

            if existing["status"] in ("completed", "failed", "saved", "discarded", "cancelled"):
                # Check if a 'failed' task was incorrectly marked by an external service
                # (e.g. spicy_demo worker claiming tasks it can't handle).
                # If error matches transient patterns and within grace period, reset and re-poll.
                if existing["status"] == "failed" and existing.get("error"):
                    is_transient = any(
                        pat.lower() in (existing["error"] or "").lower()
                        for pat in _TRANSIENT_ERROR_PATTERNS
                    )
                    task_age = None
                    if existing.get("created_at"):
                        created = existing["created_at"]
                        if created.tzinfo is None:
                            created = created.replace(tzinfo=timezone.utc)
                        task_age = (datetime.now(timezone.utc) - created).total_seconds()

                    if is_transient and task_age is not None and task_age < _TRANSIENT_GRACE_SECONDS:
                        # Reset to 'running' so we can re-poll SmartStudio below
                        print(f"[poll_status] Task {task_id} was incorrectly failed by external service (age={task_age:.0f}s, error={existing['error'][:80]}), resetting to running")
                        cur.execute(
                            """UPDATE media_generation_tasks
                               SET status = 'running', error = NULL, updated_at = NOW()
                               WHERE id = %s""",
                            (task_id,),
                        )
                        conn.commit()
                        # Fall through to SmartStudio polling below
                    else:
                        # Genuine terminal state
                        return {
                            "status": "ok",
                            "task_id": task_id,
                            "task_status": existing["status"].upper(),
                            "result_url": existing.get("result_url"),
                            "error_message": existing.get("error") or "",
                            "completed_at": existing["updated_at"].isoformat() if existing["updated_at"] else None,
                        }
                else:
                    # Already terminal (completed/saved/discarded/cancelled), return current state
                    return {
                        "status": "ok",
                        "task_id": task_id,
                        "task_status": existing["status"].upper(),
                        "result_url": existing.get("result_url"),
                        "error_message": existing.get("error") or "",
                        "completed_at": existing["updated_at"].isoformat() if existing["updated_at"] else None,
                    }

        # Poll SmartStudio
        try:
            import time as _time
            _poll_start = _time.time()
            output = await smartstudio_client.poll_task(task_id)
            _poll_elapsed = _time.time() - _poll_start
            print(f"[DEBUG poll_status] {_time.time():.3f} (took {_poll_elapsed:.3f}s) SmartStudio response: task_status={output.get('task_status')}, has_image_url={bool(output.get('image_url'))}, full_output_keys={list(output.keys())}")
        except Exception as e:
            # Network error — DON'T mark as failed yet, might be transient
            # But DO mark as failed if running > 5 minutes
            with conn.cursor() as cur:
                if existing["updated_at"]:
                    age = (datetime.now(timezone.utc) - existing["updated_at"].replace(tzinfo=timezone.utc)).total_seconds()
                    if age > 300:  # 5 minutes stuck
                        cur.execute(
                            """UPDATE media_generation_tasks
                               SET status = 'failed', error = %s, updated_at = NOW()
                               WHERE id = %s""",
                            (f"Timeout ({int(age)}s): {str(e)[:200]}", task_id),
                        )
                        conn.commit()
                        return {
                            "status": "ok", "task_id": task_id,
                            "task_status": "FAILED", "result_url": None,
                            "error_message": f"Timeout: {str(e)[:200]}",
                        }
            return {"status": "error", "message": str(e)[:200], "task_status": "POLL_ERROR"}

        task_status = output.get("task_status", "UNKNOWN")
        result_url = output.get("image_url") or output.get("video_url")
        error_message = output.get("task_message") or output.get("error_message") or ""

        if task_status == "SUCCEEDED" and result_url:
            result_url = await batch_processing._persist_url(result_url, task_id)

        print(f"[DEBUG poll_status] Updating DB: status={task_status}, error={error_message[:100]}")

        with conn.cursor() as cur:
            if task_status == "SUCCEEDED":
                cur.execute(
                    """UPDATE media_generation_tasks
                       SET status = 'completed', result_url = %s,
                           updated_at = NOW()
                       WHERE id = %s""",
                    (result_url, task_id),
                )
            elif task_status == "FAILED":
                # Check if this is a transient error within the grace period
                is_transient = any(
                    pat.lower() in (error_message or "").lower()
                    for pat in _TRANSIENT_ERROR_PATTERNS
                )
                task_age = None
                if existing.get("created_at"):
                    created = existing["created_at"]
                    if created.tzinfo is None:
                        created = created.replace(tzinfo=timezone.utc)
                    task_age = (datetime.now(timezone.utc) - created).total_seconds()

                if is_transient and task_age is not None and task_age < _TRANSIENT_GRACE_SECONDS:
                    # Transient error within grace period — keep as running, let frontend retry
                    print(f"[poll_status] Transient error for {task_id} (age={task_age:.0f}s), keeping running: {error_message[:100]}")
                    cur.execute(
                        """UPDATE media_generation_tasks
                           SET status = 'running', updated_at = NOW()
                           WHERE id = %s""",
                        (task_id,),
                    )
                    # Override task_status so the response tells frontend to keep polling
                    task_status = "RUNNING"
                    error_message = ""
                else:
                    cur.execute(
                        """UPDATE media_generation_tasks
                           SET status = 'failed', error = %s,
                               updated_at = NOW()
                           WHERE id = %s""",
                        (error_message or "SmartStudio task failed", task_id),
                    )
            elif task_status in ("RUNNING", "PENDING"):
                cur.execute(
                    """UPDATE media_generation_tasks
                       SET status = 'running', updated_at = NOW()
                       WHERE id = %s""",
                    (task_id,),
                )
            else:
                # Unknown status — log it but don't change DB status
                cur.execute(
                    """UPDATE media_generation_tasks
                       SET error = %s, updated_at = NOW()
                       WHERE id = %s""",
                    (f"Unknown status: {task_status}", task_id),
                )
        conn.commit()

        completed_at = None
        if task_status in ("SUCCEEDED", "FAILED", "COMPLETED"):
            completed_at = datetime.now(timezone.utc).isoformat()

        return {
            "status": "ok",
            "task_id": task_id,
            "task_status": task_status,
            "result_url": result_url,
            "error_message": error_message,
            "completed_at": completed_at,
        }
    finally:
        put_conn(conn)


@router.post("/save/{task_id}")
async def save_result(task_id: str, data: SaveGenerationRequest):
    """Save a completed generation task to the character's media array."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT character_id, result_url, task_type FROM media_generation_tasks WHERE id = %s",
                (task_id,),
            )
            task = cur.fetchone()
            if not task:
                return {"status": "error", "message": "Task not found"}
            if not task["result_url"]:
                return {"status": "error", "message": "No result URL yet"}

            char_id = task["character_id"]
            result_url = task["result_url"]

            # Determine the media type for the character's media array
            # Image types go to "image" or "swapface_image", videos go to "video"
            media_type = data.media_type
            if task["task_type"] in ("wan_spicy", "wan_animate"):
                media_type = "video"

            cur.execute("SELECT id, media FROM characters WHERE id = %s", (char_id,))
            row = cur.fetchone()
            if not row:
                return {"status": "error", "message": "Character not found"}

            media_list = _parse_json(row["media"]) or []
            new_item = {
                "url": result_url,
                "type": media_type,
                "source": "generation",
                "task_id": task_id,
                "task_type": task["task_type"],
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            media_list.append(new_item)

            cur.execute(
                "UPDATE characters SET media = %s::json WHERE id = %s",
                (json.dumps(media_list), char_id),
            )
            cur.execute(
                "UPDATE media_generation_tasks SET status = 'saved', updated_at = NOW() WHERE id = %s",
                (task_id,),
            )
        conn.commit()
        return {"status": "ok", "media_type": media_type}
    finally:
        put_conn(conn)


@router.post("/discard/{task_id}")
async def discard_task(task_id: str):
    """Mark a task as discarded."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE media_generation_tasks SET status = 'discarded', updated_at = NOW() WHERE id = %s",
                (task_id,),
            )
        conn.commit()
        return {"status": "ok"}
    finally:
        put_conn(conn)


@router.post("/cancel/{task_id}")
async def cancel_task(task_id: str):
    """Cancel a running/pending task. SmartStudio has no cancel API,
    so we just mark the DB row as cancelled and stop polling."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE media_generation_tasks
                   SET status = 'cancelled', error = '用户手动取消',
                       updated_at = NOW()
                   WHERE id = %s AND status IN ('running', 'pending')""",
                (task_id,),
            )
            if cur.rowcount == 0:
                return {"status": "error", "message": "任务不在运行状态或不存在"}
        conn.commit()
        return {"status": "ok"}
    finally:
        put_conn(conn)


@router.post("/batch-save")
async def batch_save(data: BatchActionRequest):
    """Save multiple completed tasks at once."""
    conn = get_conn()
    try:
        results = []
        for tid in data.task_ids:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    "SELECT character_id, result_url, task_type FROM media_generation_tasks WHERE id = %s",
                    (tid,),
                )
                task = cur.fetchone()
                if not task or not task["result_url"]:
                    results.append({"task_id": tid, "status": "skipped"})
                    continue

                char_id = task["character_id"]
                result_url = task["result_url"]
                media_type = "video" if task["task_type"] in ("wan_spicy", "wan_animate") else "image"

                cur.execute("SELECT id, media FROM characters WHERE id = %s", (char_id,))
                row = cur.fetchone()
                if not row:
                    results.append({"task_id": tid, "status": "error", "message": "No character"})
                    continue

                media_list = _parse_json(row["media"]) or []
                media_list.append({
                    "url": result_url,
                    "type": media_type,
                    "source": "generation",
                    "task_id": tid,
                    "task_type": task["task_type"],
                    "created_at": datetime.now(timezone.utc).isoformat(),
                })

                cur.execute(
                    "UPDATE characters SET media = %s::json WHERE id = %s",
                    (json.dumps(media_list), char_id),
                )
                cur.execute(
                    "UPDATE media_generation_tasks SET status = 'saved', updated_at = NOW() WHERE id = %s",
                    (tid,),
                )
                results.append({"task_id": tid, "status": "saved", "media_type": media_type})
        conn.commit()
        return {"status": "ok", "results": results}
    finally:
        put_conn(conn)


@router.post("/batch-discard")
async def batch_discard(data: BatchActionRequest):
    """Discard multiple tasks at once."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            if data.task_ids:
                print(f"[batch_discard] Discarding {len(data.task_ids)} tasks: {data.task_ids}")
                placeholders = ','.join(['%s'] * len(data.task_ids))
                cur.execute(
                    f"UPDATE media_generation_tasks SET status = 'discarded', updated_at = NOW() WHERE id IN ({placeholders})",
                    tuple(data.task_ids),
                )
        conn.commit()
        return {"status": "ok", "discarded": len(data.task_ids)}
    finally:
        put_conn(conn)


@router.post("/random-cards")
async def random_cards(data: RandomCardsRequest):
    """Get random cards from VFE asset library as source material."""
    limit = data.count
    # Sample across the full VFE library (current ~18k cards, will grow) so
    # users also see older annotated cards whose video_prompt / i2v_prompt
    # fields were populated at different points in time.
    total = 20000
    offset = random.randint(0, max(0, total - limit))

    try:
        from services import vfe_client
        result = await vfe_client.search_images(
            character_name=None, limit=limit + len(data.exclude_paths), offset=offset,
        )
    except Exception as e:
        return {"status": "error", "cards": [], "message": str(e)}

    items = result.get("items", [])
    exclude_set = set(data.exclude_paths)
    cards = [item for item in items if item.get("video_path") not in exclude_set][:limit]

    return {"status": "ok", "cards": cards, "total": len(cards)}


# ---------- Unified batch processing (faceswap / zimage / imageedit / video) ----------

@router.post("/batch-generate")
async def batch_generate_start(data: BatchGenerateRequest):
    """Start a batch job over characters in the current data source.

    type:
      zimage    — K random VFE prompts per character -> text-to-image
      imageedit — K random VFE prompts per character, base = avatar -> edit
      faceswap  — face = avatar; body from VFE face_nsfw material (swap_direct)
                  and from zimage-generated image (swap_zimage)
      video     — existing swap/edit images as first frame + VFE video_prompt -> wan
    Results are saved as pending media for review (待选).
    """
    ds = get_data_source()
    return batch_processing.start_job(
        ds, data.type, per_character=data.per_character, category=data.category,
        width=data.width, height=data.height, seed=data.seed,
        edit_prompt=data.edit_prompt, engine=data.engine,
        overwrite=data.overwrite,
    )


@router.get("/batch-generate/anime-default-prompt")
async def batch_generate_anime_default_prompt():
    """Return the default anime restyle edit prompt and all available presets."""
    return {
        "status": "ok",
        "edit_prompt": batch_processing.ANIME_EDIT_PROMPT,
        "presets": batch_processing.PRESET_EDIT_PROMPTS,
    }


@router.get("/batch-generate/status")
async def batch_generate_status(job_id: str | None = None):
    job = batch_processing.get_job(job_id)
    if job is None:
        return {"status": "ok", "job": None}
    return {"status": "ok", "job": job}


@router.post("/batch-generate/stop")
async def batch_generate_stop(job_id: str | None = None):
    return batch_processing.stop_job(job_id)


@router.post("/batch-generate/resume")
async def batch_generate_resume(job_id: str | None = None):
    """Resume a previously interrupted batch job. Skips units already done.
    If job_id is omitted the server picks the most recently interrupted job."""
    return batch_processing.resume_job(job_id)


@router.get("/batch-generate/jobs")
async def batch_generate_list_jobs():
    """List all known batch jobs (in-memory + persisted) for the UI."""
    return {"status": "ok", "jobs": batch_processing.list_jobs()}


@router.post("/comfyui/free-vram")
async def comfyui_free_vram():
    """Send /free to all ComfyUI instances to unload models and release VRAM."""
    import aiohttp
    from services.comfyui_single import COMFYUI_HOST, COMFYUI_PORTS

    freed = 0
    errors = []
    async with aiohttp.ClientSession() as session:
        for port in COMFYUI_PORTS:
            try:
                async with session.post(
                    f"http://{COMFYUI_HOST}:{port}/free",
                    json={"unload_models": True, "free_memory": True},
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    if resp.status == 200:
                        freed += 1
                    else:
                        errors.append(f"{port}: HTTP {resp.status}")
            except Exception as e:
                errors.append(f"{port}: {type(e).__name__}")
    return {
        "status": "ok",
        "freed": freed,
        "total": len(COMFYUI_PORTS),
        "errors": errors[:10] if errors else None,
    }
