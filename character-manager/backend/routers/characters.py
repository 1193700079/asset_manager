import json
from typing import Any
from fastapi import APIRouter, Query, Request
from pydantic import BaseModel
import psycopg2.extras
from database import get_conn, put_conn, fetch_merged, get_data_source, conn_for, put_conn_named
from services import auth
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


def _strip_pending_media(media_list):
    """Remove media entries with media_status='pending' — used for production
    (show_all=False) responses so ecjoy never renders unreviewed content."""
    if not media_list or not isinstance(media_list, list):
        return media_list
    return [
        m for m in media_list
        if not (isinstance(m, dict) and m.get("media_status") == "pending")
    ]


@router.get("", response_model=list[CharacterOut])
async def list_characters(category: str | None = None, show_all: bool = False):
    status_filter = "" if show_all else "AND COALESCE(character_status, 'pending') = 'online'"
    creator_filter = "" if get_data_source() == "ecjoy" else "AND creator_id IN ('official', 'system')"
    base = f"""SELECT id, name, category, description, attributes, media,
                      content_rating, sort_priority
               FROM characters
               WHERE (is_deleted IS NULL OR is_deleted = FALSE)
                 {{creator}}
                 {{cat}}
                 {status_filter}"""
    if category:
        rows = fetch_merged(base.format(creator=creator_filter, cat="AND category = %s"), (category,))
    else:
        rows = fetch_merged(base.format(creator=creator_filter, cat=""))
    for r in rows:
        r["attributes"] = _parse_json(r["attributes"])
        media = _filter_active_media(_parse_json(r["media"]))
        if not show_all:
            media = _strip_pending_media(media)
        r["media"] = media
    rows.sort(key=lambda r: (r.get("name") or "").lower())
    return rows


@router.get("/list", response_model=list[CharacterListItem])
async def list_characters_simple(show_all: bool = False):
    status_filter = "" if show_all else "AND COALESCE(character_status, 'pending') = 'online'"
    creator_filter = "" if get_data_source() == "ecjoy" else "AND creator_id IN ('official', 'system')"
    rows = fetch_merged(
        f"""SELECT id, name, category FROM characters
           WHERE (is_deleted IS NULL OR is_deleted = FALSE)
             {creator_filter}
             {status_filter}"""
    )
    rows.sort(key=lambda r: (r.get("name") or "").lower())
    return rows


@router.get("/categories", response_model=list[CategoryCount])
async def get_categories(show_all: bool = False):
    status_filter = "" if show_all else "AND COALESCE(character_status, 'pending') = 'online'"
    creator_filter = "" if get_data_source() == "ecjoy" else "AND creator_id IN ('official', 'system')"
    rows = fetch_merged(
        f"""SELECT category, count(*) as count FROM characters
           WHERE (is_deleted IS NULL OR is_deleted = FALSE)
             {creator_filter}
             {status_filter}
           GROUP BY category"""
    )
    agg: dict[str, int] = {}
    for r in rows:
        agg[r["category"]] = agg.get(r["category"], 0) + int(r["count"])
    return [{"category": k, "count": v}
            for k, v in sorted(agg.items(), key=lambda x: x[1], reverse=True)]


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
    _pool, conn = conn_for(name=name)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE characters SET is_deleted = TRUE, deleted_at = NOW() WHERE name = %s",
                (name,),
            )
        conn.commit()
        return {"status": "ok"}
    finally:
        put_conn_named(_pool, conn)


@router.post("/{name}/clear")
async def clear_character(name: str):
    """Clear a character's avatar and all media, keeping the record."""
    _pool, conn = conn_for(name=name)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE characters SET avatar_url = NULL, media = '[]'::json WHERE name = %s",
                (name,),
            )
        conn.commit()
        return {"status": "ok"}
    finally:
        put_conn_named(_pool, conn)


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


class ProfileUpdateRequest(BaseModel):
    character_id: int
    current_name: str | None = None
    name: str | None = None
    category: str | None = None
    description: str | None = None
    attributes: dict[str, Any] | None = None


@router.put("/profile")
async def update_character_profile(data: ProfileUpdateRequest):
    """Edit a character's editable profile fields (name, category, description,
    attributes). Only the fields provided (non-null) are updated."""
    sets: list[str] = []
    params: list = []
    if data.name is not None:
        new_name = data.name.strip()
        if not new_name:
            return {"status": "error", "message": "名称不能为空"}
        sets.append("name = %s")
        params.append(new_name)
    if data.category is not None:
        sets.append("category = %s")
        params.append(data.category.strip() or "uncategorized")
    if data.description is not None:
        sets.append("description = %s")
        params.append(data.description)
    if data.attributes is not None:
        sets.append("attributes = %s::json")
        params.append(json.dumps(data.attributes))

    if not sets:
        return {"status": "error", "message": "没有需要更新的字段"}

    params.append(data.character_id)
    _pool, conn = (conn_for(name=data.current_name) if data.current_name else conn_for(cid=data.character_id))
    try:
        with conn.cursor() as cur:
            try:
                cur.execute(
                    f"UPDATE characters SET {', '.join(sets)} WHERE id = %s RETURNING name",
                    params,
                )
                row = cur.fetchone()
            except psycopg2.errors.UniqueViolation:
                conn.rollback()
                return {"status": "error", "message": "该名称已被占用"}
        conn.commit()
        if not row:
            return {"status": "error", "message": "角色不存在"}
        return {"status": "ok", "name": row[0]}
    finally:
        put_conn_named(_pool, conn)


class FeaturedRequest(BaseModel):
    character_id: int
    featured: bool


@router.post("/featured")
async def set_featured(data: FeaturedRequest, request: Request):
    """标记/取消角色为精品 (★)。"""
    _pool, conn = conn_for(cid=data.character_id)
    try:
        with conn.cursor() as cur:
            cur.execute("UPDATE characters SET featured = %s WHERE id = %s",
                        (data.featured, data.character_id))
        conn.commit()
    finally:
        put_conn_named(_pool, conn)
    user = auth.user_from_request(request)
    auth.log_action(user, "featured" if data.featured else "unfeatured", str(data.character_id))
    return {"status": "ok", "featured": data.featured}


class TagsRequest(BaseModel):
    character_id: int
    tags: list[str]


@router.post("/tags")
async def set_tags(data: TagsRequest, request: Request):
    """设置角色的自定义标签（整组覆盖，去重/去空/限长）。"""
    clean: list[str] = []
    for t in data.tags:
        t = (t or "").strip()
        if t and t not in clean and len(t) <= 20:
            clean.append(t)
    _pool, conn = conn_for(cid=data.character_id)
    try:
        with conn.cursor() as cur:
            cur.execute("UPDATE characters SET tags = %s::json WHERE id = %s",
                        (json.dumps(clean), data.character_id))
        conn.commit()
    finally:
        put_conn_named(_pool, conn)
    user = auth.user_from_request(request)
    auth.log_action(user, "set-tags", str(data.character_id))
    return {"status": "ok", "tags": clean}
