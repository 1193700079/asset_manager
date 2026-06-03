import json
from datetime import datetime
from fastapi import APIRouter
from pydantic import BaseModel
import psycopg2.extras
from database import get_conn, put_conn

router = APIRouter(prefix="/api/media", tags=["media"])


def _parse_json(val):
    if val is None:
        return None
    if isinstance(val, (list, dict)):
        return val
    try:
        return json.loads(val)
    except (json.JSONDecodeError, TypeError):
        return None


class DeleteRequest(BaseModel):
    name: str
    image_url: str


class RestoreRequest(BaseModel):
    name: str
    image_url: str


class EmptyTrashRequest(BaseModel):
    name: str


class MediaStatusRequest(BaseModel):
    character_id: int
    url: str
    media_status: str  # online | pre_release | pending


@router.post("/status")
async def update_media_status(data: MediaStatusRequest):
    """Set per-media status: online, pre_release, or pending."""
    valid = {"online", "pre_release", "pending"}
    if data.media_status not in valid:
        return {"status": "error", "message": f"Invalid status. Must be one of: {valid}"}

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            # Update in character_media table (if exists)
            cur.execute(
                """UPDATE character_media SET media_status = %s
                   WHERE character_id = %s AND url = %s""",
                (data.media_status, data.character_id, data.url),
            )

            # Also update in character.media JSON array
            cur.execute("SELECT id, media FROM characters WHERE id = %s", (data.character_id,))
            row = cur.fetchone()
            if row:
                cid, media_raw = row
                media_list = _parse_json(media_raw) or []
                for m in media_list:
                    if isinstance(m, dict) and m.get("url") == data.url:
                        m["media_status"] = data.media_status
                cur.execute(
                    "UPDATE characters SET media = %s::json WHERE id = %s",
                    (json.dumps(media_list), cid),
                )
        conn.commit()
        return {"status": "ok", "media_status": data.media_status}
    finally:
        put_conn(conn)


@router.post("/delete")
async def soft_delete(data: DeleteRequest):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, media FROM characters WHERE name = %s", (data.name,))
            row = cur.fetchone()
            if row:
                cid, media_raw = row
                media_list = _parse_json(media_raw) or []
                now = datetime.now().isoformat()
                for m in media_list:
                    if isinstance(m, dict) and m.get("url") == data.image_url and not m.get("is_deleted"):
                        m["is_deleted"] = True
                        m["deleted_at"] = now
                cur.execute(
                    "UPDATE characters SET media = %s::json WHERE id = %s",
                    (json.dumps(media_list), cid),
                )
        conn.commit()
        return {"status": "ok"}
    finally:
        put_conn(conn)


@router.post("/restore")
async def restore(data: RestoreRequest):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, media FROM characters WHERE name = %s", (data.name,))
            row = cur.fetchone()
            if row:
                cid, media_raw = row
                media_list = _parse_json(media_raw) or []
                for m in media_list:
                    if isinstance(m, dict) and m.get("url") == data.image_url:
                        m.pop("is_deleted", None)
                        m.pop("deleted_at", None)
                cur.execute(
                    "UPDATE characters SET media = %s::json WHERE id = %s",
                    (json.dumps(media_list), cid),
                )
        conn.commit()
        return {"status": "ok"}
    finally:
        put_conn(conn)


@router.post("/trash/empty")
async def empty_trash(data: EmptyTrashRequest):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, media FROM characters WHERE name = %s", (data.name,))
            row = cur.fetchone()
            if row:
                cid, media_raw = row
                media_list = _parse_json(media_raw) or []
                media_list = [m for m in media_list if not (isinstance(m, dict) and m.get("is_deleted"))]
                cur.execute(
                    "UPDATE characters SET media = %s::json WHERE id = %s",
                    (json.dumps(media_list), cid),
                )
        conn.commit()
        return {"status": "ok"}
    finally:
        put_conn(conn)
