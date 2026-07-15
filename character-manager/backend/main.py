import json
import signal
import threading
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
import psycopg2.extras
from config import settings
from database import init_pool, close_pool, get_conn, put_conn, set_data_source, fetch_merged, get_data_source
from routers import characters_router, media_router, reference_router, asset_library_router, generation_router, scripts_router, comfyui_single_router, avatar_router, audio_router, batch_generate_router
from routers.config import router as config_router
from routers.auth import router as auth_router
from routers.modelark import router as modelark_router
from services import smartstudio_client, script_runner
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
        _r = batch_processing.resume_job(None)
        print(f"[startup] batch auto-resume: {_r}")
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
    await smartstudio_client.close_client()
    close_pool()


app = FastAPI(title="Character Manager", lifespan=lifespan)

app.add_middleware(GZipMiddleware, minimum_size=1024)

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
app.include_router(config_router)
app.include_router(auth_router)
app.include_router(modelark_router)


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
        "sources": settings.public_datasources,
        "default": settings.default_data_source,
    }


@app.get("/api/index")
async def get_index(show_all: bool = False, name: str | None = None):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            status_filter = "" if show_all else "AND COALESCE(character_status, 'pending') = 'online'"
            creator_filter = "" if get_data_source() == "ecjoy" else "AND creator_id IN ('official', 'system')"
            # name=<one char> -> build the index for just that character (cheap refresh)
            name_filter = "AND name = %s" if name else ""
            chars = fetch_merged(
                f"""SELECT id, name, category, description, attributes, media, tags,
                          content_rating, sort_priority, avatar_url, voice_id,
                          COALESCE(character_status, 'pending') as character_status
                   FROM characters
                   WHERE (is_deleted IS NULL OR is_deleted = FALSE)
                     {creator_filter}
                     {status_filter}
                     {name_filter}
                   ORDER BY name""",
                (name,) if name else None
            )

            gen_filter = "AND character_id = ANY(%s)" if name else ""
            gen_params = ([c["id"] for c in chars],) if name else None
            gen_tasks = fetch_merged(
                f"""SELECT character_id, result_url, task_type, status, created_at
                   FROM media_generation_tasks
                   WHERE status = 'completed' AND result_url IS NOT NULL
                     {gen_filter}
                   ORDER BY created_at DESC""",
                gen_params
            )

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

            def _is_paid(mm):
                t = mm.get("tier")
                if t == "free":
                    return False
                return t == "paid" or mm.get("source") == "imageedit"

            def _akind(m):
                return m.get("asset_kind")
            costume_images = [m["url"] for m in published
                              if m.get("type") == "image" and m.get("url") and _akind(m) == "costume"]
            scene_images = [m["url"] for m in published
                            if m.get("type") == "image" and m.get("url") and _akind(m) == "scene"]
            prop_images = [m["url"] for m in published
                           if m.get("type") == "image" and m.get("url") and _akind(m) == "prop"]
            paid_images = [m["url"] for m in published
                           if m.get("type") == "image" and m.get("url") and _is_paid(m) and not _akind(m)]
            profile_images = [m["url"] for m in published
                              if m.get("type") == "image" and m.get("url") and not _is_paid(m) and not _akind(m)]
            profile_videos = [m["url"] for m in published if m.get("type") == "video" and m.get("url")]
            swapface_images = [m["url"] for m in published if m.get("type") == "swapface_image" and m.get("url")]

            # Per-media status maps.
            # Production (show_all=False) MUST NOT expose any pending entries —
            # ecjoy frontend would render them otherwise. Admin UI (show_all=True)
            # keeps the full map so reviewers can see pending items.
            media_status_map: dict[str, str] = {}
            for m in active:
                if isinstance(m, dict) and m.get("url"):
                    status = m.get("media_status", "pending")
                    if not show_all and status == "pending":
                        continue
                    media_status_map[m["url"]] = status

            # Pending (待选) media for the review section — only explicit 'pending'.
            # Hidden entirely from production responses (show_all=False).
            if show_all:
                pending_media = [
                    {
                        "url": m["url"],
                        "type": m.get("type", "image"),
                        "source": m.get("source", ""),
                        "created_at": m.get("created_at"),
                    }
                    for m in active
                    if isinstance(m, dict) and m.get("url") and _is_pending(m)
                ]
            else:
                pending_media = []

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
                "featured": bool(c.get("featured")),
                "tags": [t for t in (_parse_json(c.get("tags")) or []) if isinstance(t, str)],
                "voice_id": c["voice_id"] or "",
                "profile_images": profile_images,
                "paid_images": paid_images,
                "costume_images": costume_images,
                "scene_images": scene_images,
                "prop_images": prop_images,
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
        # featured 是 ecjoy 源上的全局精品标记 (tiktok 源的表无此列且不可改),
        # 单独在当前(ecjoy)连接查一次, 覆盖各角色的 featured。
        featured_ids = set()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM characters WHERE featured = true")
                featured_ids = {r[0] for r in cur.fetchall()}
        except Exception:
            pass
        for _e in index.values():
            _e["featured"] = _e["id"] in featured_ids
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
