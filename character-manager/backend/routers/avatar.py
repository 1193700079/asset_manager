"""Router for character avatar generation (face-centered crop)."""
import json

from fastapi import APIRouter
from fastapi.responses import FileResponse
from pydantic import BaseModel
import psycopg2.extras

from database import get_conn, put_conn
from services import avatar

router = APIRouter(prefix="/api/avatar", tags=["avatar"])


class SetAvatarRequest(BaseModel):
    character_id: int
    image_url: str


@router.post("/set")
async def set_avatar(data: SetAvatarRequest):
    """Detect face in image_url, crop a centered square, save as the character's avatar."""
    result = await avatar.generate_avatar(data.image_url)
    if not result.get("ok"):
        return {"status": "error", "message": result.get("error", "avatar generation failed")}

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE characters SET avatar_url = %s WHERE id = %s",
                (result["avatar_url"], data.character_id),
            )
        conn.commit()
    finally:
        put_conn(conn)

    return {
        "status": "ok",
        "avatar_url": result["avatar_url"],
        "face_found": result["face_found"],
    }


class BatchAvatarRequest(BaseModel):
    only_missing: bool = True
    limit: int = 0  # 0 = no limit


@router.post("/batch")
async def batch_avatars(data: BatchAvatarRequest):
    """Generate avatars for characters using their first profile image.

    By default only fills characters that have no avatar yet.
    """
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            query = """SELECT id, name, media, avatar_url
                       FROM characters
                       WHERE (is_deleted IS NULL OR is_deleted = FALSE)"""
            if data.only_missing:
                query += " AND (avatar_url IS NULL OR avatar_url = '')"
            query += " ORDER BY name"
            cur.execute(query)
            rows = cur.fetchall()
    finally:
        put_conn(conn)

    processed = 0
    succeeded = 0
    failed = 0
    no_image = 0
    results = []

    for row in rows:
        if data.limit and processed >= data.limit:
            break
        media = row["media"]
        if isinstance(media, str):
            try:
                media = json.loads(media)
            except (json.JSONDecodeError, TypeError):
                media = []
        media = media or []
        first_image = next(
            (m["url"] for m in media
             if isinstance(m, dict) and m.get("type") == "image"
             and m.get("url") and not m.get("is_deleted")),
            None,
        )
        if not first_image:
            no_image += 1
            continue

        processed += 1
        result = await avatar.generate_avatar(first_image)
        if not result.get("ok"):
            failed += 1
            results.append({"id": row["id"], "name": row["name"], "ok": False,
                            "error": result.get("error")})
            continue

        conn = get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE characters SET avatar_url = %s WHERE id = %s",
                    (result["avatar_url"], row["id"]),
                )
            conn.commit()
        finally:
            put_conn(conn)
        succeeded += 1
        results.append({"id": row["id"], "name": row["name"], "ok": True,
                        "face_found": result["face_found"]})

    return {
        "status": "ok",
        "processed": processed,
        "succeeded": succeeded,
        "failed": failed,
        "no_image": no_image,
        "results": results,
    }


@router.get("/file/{filename}")
async def get_avatar_file(filename: str):
    path = avatar.get_avatar_file(filename)
    if path is None:
        return {"status": "error", "message": "File not found"}
    return FileResponse(path)
