import json
import signal
import threading
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
import psycopg2.extras
from config import settings
from database import init_pool, close_pool, get_conn, put_conn, set_data_source
from routers import characters_router, media_router, reference_router, asset_library_router, generation_router, scripts_router, comfyui_single_router, avatar_router, audio_router, batch_generate_router
from services import vfe_client, smartstudio_client, script_runner
from services import batch_processing
from services.supabase_storage import ensure_bucket_exists


def _parse_json(val):
    if val is None:
        return None
    if isinstance(val, (list, dict)):
        return val
    try:
        return json.loads(val)
    except (json.JSONDecodeError, TypeError):
        return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_pool()
    await ensure_bucket_exists()

    # Ensure audio_library table exists
    try:
        conn = get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS audio_library (
                        id SERIAL PRIMARY KEY,
                        filename TEXT NOT NULL,
                        original_path TEXT NOT NULL,
                        category TEXT NOT NULL,
                        duration FLOAT,
                        file_hash TEXT UNIQUE NOT NULL,
                        oss_url TEXT,
                        oss_key TEXT,
                        assigned_to INTEGER,
                        created_at TIMESTAMP DEFAULT NOW()
                    )
                """)
            conn.commit()
        finally:
            put_conn(conn)
    except Exception as e:
        print(f"[audio] table migration failed: {e}")

    # Load persisted batch jobs from disk so the UI can resume any that were
    # cut off by a previous crash/restart. Best-effort: never fatal.
    try:
        batch_processing.recover_on_startup()
    except Exception as e:
        print(f"[batch] startup recovery failed: {e}")

    # Kill all running batch script jobs on shutdown
    def _cleanup():
        for job in script_runner.list_jobs():
            if job["status"] == "running":
                try:
                    script_runner.kill_job(job["job_id"])
                except Exception:
                    pass

    signal.signal(signal.SIGTERM, lambda *_: _cleanup())
    signal.signal(signal.SIGINT, lambda *_: _cleanup())

    yield
    await vfe_client.close_client()
    await smartstudio_client.close_client()
    close_pool()


app = FastAPI(title="Character Manager", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(characters_router)
app.include_router(media_router)
app.include_router(reference_router)
app.include_router(asset_library_router)
app.include_router(generation_router)
app.include_router(scripts_router)
app.include_router(comfyui_single_router)
app.include_router(avatar_router)
app.include_router(batch_generate_router)
app.include_router(audio_router)


@app.middleware("http")
async def data_source_middleware(request: Request, call_next):
    requested = request.headers.get("X-Data-Source")
    if requested in settings.datasources:
        set_data_source(requested)
    else:
        set_data_source(settings.default_data_source)
    return await call_next(request)


@app.get("/api/datasources")
async def list_datasources():
    return {
        "sources": list(settings.datasources.keys()),
        "default": settings.default_data_source,
    }


@app.get("/api/index")
async def get_index(show_all: bool = False):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            status_filter = "" if show_all else "AND COALESCE(character_status, 'pending') = 'online'"
            cur.execute(
                f"""SELECT id, name, category, description, attributes, media,
                          content_rating, sort_priority, avatar_url, voice_id,
                          COALESCE(character_status, 'pending') as character_status
                   FROM characters
                   WHERE (is_deleted IS NULL OR is_deleted = FALSE)
                     AND creator_id = 'official'
                     {status_filter}
                   ORDER BY name"""
            )
            chars = cur.fetchall()

            cur.execute(
                """SELECT character_id, result_url, task_type, status, created_at
                   FROM media_generation_tasks
                   WHERE status = 'completed' AND result_url IS NOT NULL
                   ORDER BY created_at DESC"""
            )
            gen_tasks = cur.fetchall()

        gen_by_char: dict[int, list] = {}
        for t in gen_tasks:
            cid = t["character_id"]
            gen_by_char.setdefault(cid, []).append({
                "url": t["result_url"],
                "type": t["task_type"],
                "created_at": t["created_at"].isoformat() if t["created_at"] else None,
            })

        index: dict = {}
        for c in chars:
            name = c["name"]
            if not name:
                continue

            attrs = _parse_json(c["attributes"]) or {}
            media_list = _parse_json(c["media"]) or []

            active = [m for m in media_list if isinstance(m, dict) and not m.get("is_deleted")]
            trashed = [m for m in media_list if isinstance(m, dict) and m.get("is_deleted")]

            def _is_pending(m):
                return m.get("media_status") == "pending"

            # Published (non-pending) media shows in the profile/generated sections.
            # Items without a media_status (legacy) count as published.
            published = [m for m in active if not _is_pending(m)]

            profile_images = [m["url"] for m in published if m.get("type") == "image" and m.get("url")]
            profile_videos = [m["url"] for m in published if m.get("type") == "video" and m.get("url")]
            swapface_images = [m["url"] for m in published if m.get("type") == "swapface_image" and m.get("url")]

            # Per-media status maps
            media_status_map: dict[str, str] = {}
            for m in active:
                if isinstance(m, dict) and m.get("url"):
                    media_status_map[m["url"]] = m.get("media_status", "pending")

            # Pending (待选) media for the review section — only explicit 'pending'.
            pending_media = [
                {
                    "url": m["url"],
                    "type": m.get("type", "image"),
                    "source": m.get("source", ""),
                }
                for m in active
                if isinstance(m, dict) and m.get("url") and _is_pending(m)
            ]

            trash_images = [m["url"] for m in trashed if m.get("type") == "image" and m.get("url")]
            trash_videos = [m["url"] for m in trashed if m.get("type") == "video" and m.get("url")]
            trash_generated = [m["url"] for m in trashed if m.get("type") == "swapface_image" and m.get("url")]

            gen_images = [g["url"] for g in gen_by_char.get(c["id"], []) if g["type"] == "image"]
            generated_images = list(dict.fromkeys(swapface_images + gen_images))

            index[name] = {
                "id": c["id"],
                "category": c["category"] or "uncategorized",
                "description": c["description"] or "",
                "attributes": attrs,
                "content_rating": c["content_rating"] or "sfw",
                "character_status": c["character_status"] or "pending",
                "avatar_url": c["avatar_url"] or "",
                "voice_id": c["voice_id"] or "",
                "profile_images": profile_images,
                "profile_videos": profile_videos,
                "generated_images": generated_images,
                "all_images": profile_images + generated_images,
                "trash_images": trash_images,
                "trash_videos": trash_videos,
                "trash_generated": trash_generated,
                "trash_all": trash_images + trash_videos + trash_generated,
                "media_status_map": media_status_map,
                "pending_media": pending_media,
            }
        return index
    finally:
        put_conn(conn)


@app.get("/api/rebuild")
async def rebuild():
    idx = await get_index()
    return {"status": "ok", "count": len(idx)}


@app.get("/api/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8889)
