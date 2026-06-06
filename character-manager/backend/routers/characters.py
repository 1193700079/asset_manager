import json
from fastapi import APIRouter, Query
from pydantic import BaseModel
import psycopg2.extras
from database import get_conn, put_conn
from models import CharacterBase, CharacterOut, CharacterListItem, CategoryCount

router = APIRouter(prefix="/api/characters", tags=["characters"])


def _parse_json(val):
    if val is None:
        return None
    if isinstance(val, (list, dict)):
        return val
    try:
        return json.loads(val)
    except (json.JSONDecodeError, TypeError):
        return None


def _filter_active_media(media_list):
    """Filter out soft-deleted media items (is_deleted=True) for normal display."""
    if not media_list or not isinstance(media_list, list):
        return media_list
    return [m for m in media_list if not (isinstance(m, dict) and m.get("is_deleted"))]


@router.get("", response_model=list[CharacterOut])
async def list_characters(category: str | None = None, show_all: bool = False):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            status_filter = "" if show_all else "AND COALESCE(character_status, 'pending') = 'online'"
            if category:
                cur.execute(
                    f"""SELECT id, name, category, description, attributes, media,
                              content_rating, sort_priority
                       FROM characters
                       WHERE (is_deleted IS NULL OR is_deleted = FALSE)
                         AND creator_id = 'official' AND category = %s
                         {status_filter}
                       ORDER BY name""",
                    (category,),
                )
            else:
                cur.execute(
                    f"""SELECT id, name, category, description, attributes, media,
                              content_rating, sort_priority
                       FROM characters
                       WHERE (is_deleted IS NULL OR is_deleted = FALSE)
                         AND creator_id = 'official'
                         {status_filter}
                       ORDER BY name"""
                )
            rows = cur.fetchall()
        for r in rows:
            r["attributes"] = _parse_json(r["attributes"])
            r["media"] = _filter_active_media(_parse_json(r["media"]))
        return rows
    finally:
        put_conn(conn)


@router.get("/list", response_model=list[CharacterListItem])
async def list_characters_simple():
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT id, name, category FROM characters
                   WHERE (is_deleted IS NULL OR is_deleted = FALSE)
                     AND creator_id = 'official'
                   ORDER BY name"""
            )
            return cur.fetchall()
    finally:
        put_conn(conn)


@router.get("/categories", response_model=list[CategoryCount])
async def get_categories():
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT category, count(*) as count FROM characters
                   WHERE (is_deleted IS NULL OR is_deleted = FALSE)
                     AND creator_id = 'official'
                   GROUP BY category ORDER BY count(*) DESC"""
            )
            return cur.fetchall()
    finally:
        put_conn(conn)


@router.post("", response_model=dict)
async def create_character(data: CharacterBase):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO characters (name, category, description, attributes, media)
                   VALUES (%s, %s, %s, %s::json, %s::json)
                   ON CONFLICT DO NOTHING RETURNING id""",
                (
                    data.name, data.category, data.description,
                    json.dumps(data.attributes), json.dumps(data.media),
                ),
            )
            row = cur.fetchone()
        conn.commit()
        return {"status": "ok", "id": row[0] if row else None}
    finally:
        put_conn(conn)


@router.delete("/{name}")
async def delete_character(name: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE characters SET is_deleted = TRUE, deleted_at = NOW() WHERE name = %s",
                (name,),
            )
        conn.commit()
        return {"status": "ok"}
    finally:
        put_conn(conn)


@router.post("/{name}/clear")
async def clear_character(name: str):
    """Clear a character's avatar and all media, keeping the record."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE characters SET avatar_url = NULL, media = '[]'::json WHERE name = %s",
                (name,),
            )
        conn.commit()
        return {"status": "ok"}
    finally:
        put_conn(conn)


class StatusUpdateRequest(BaseModel):
    character_id: int
    character_status: str  # online | pre_release | pending


@router.put("/status")
async def update_character_status(data: StatusUpdateRequest):
    """Update a character's lifecycle status: online, pre_release, or pending."""
    valid_statuses = {"online", "pre_release", "pending"}
    if data.character_status not in valid_statuses:
        return {"status": "error", "message": f"Invalid status. Must be one of: {valid_statuses}"}
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE characters SET character_status = %s WHERE id = %s",
                (data.character_status, data.character_id),
            )
        conn.commit()
        return {"status": "ok", "character_status": data.character_status}
    finally:
        put_conn(conn)


class VoiceUpdateRequest(BaseModel):
    character_id: int
    voice_id: str  # default audio file URL (empty string clears it)


@router.put("/voice")
async def update_character_voice(data: VoiceUpdateRequest):
    """Set a character's default audio. voice_id is an audio file URL (or empty to clear)."""
    voice_id = (data.voice_id or "").strip() or None
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE characters SET voice_id = %s WHERE id = %s",
                (voice_id, data.character_id),
            )
        conn.commit()
        return {"status": "ok", "voice_id": voice_id}
    finally:
        put_conn(conn)
