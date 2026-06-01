import json
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import psycopg2.extras
from config import settings
from database import init_pool, close_pool, get_conn, put_conn
from routers import characters_router, media_router, reference_router, asset_library_router
from services import vfe_client


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
    yield
    await vfe_client.close_client()
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


@app.get("/api/index")
async def get_index():
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT id, name, category, description, attributes, media,
                          content_rating, sort_priority
                   FROM characters
                   WHERE (is_deleted IS NULL OR is_deleted = FALSE)
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

            profile_images = [m["url"] for m in active if m.get("type") == "image" and m.get("url")]
            profile_videos = [m["url"] for m in active if m.get("type") == "video" and m.get("url")]
            swapface_images = [m["url"] for m in active if m.get("type") == "swapface_image" and m.get("url")]

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
                "profile_images": profile_images,
                "profile_videos": profile_videos,
                "generated_images": generated_images,
                "all_images": profile_images + generated_images,
                "trash_images": trash_images,
                "trash_videos": trash_videos,
                "trash_generated": trash_generated,
                "trash_all": trash_images + trash_videos + trash_generated,
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
