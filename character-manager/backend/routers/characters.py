import json
from fastapi import APIRouter, Query
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


@router.get("", response_model=list[CharacterOut])
async def list_characters(category: str | None = None):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if category:
                cur.execute(
                    """SELECT id, name, category, description, attributes, media,
                              content_rating, sort_priority
                       FROM characters
                       WHERE (is_deleted IS NULL OR is_deleted = FALSE) AND category = %s
                       ORDER BY name""",
                    (category,),
                )
            else:
                cur.execute(
                    """SELECT id, name, category, description, attributes, media,
                              content_rating, sort_priority
                       FROM characters
                       WHERE (is_deleted IS NULL OR is_deleted = FALSE)
                       ORDER BY name"""
                )
            rows = cur.fetchall()
        for r in rows:
            r["attributes"] = _parse_json(r["attributes"])
            r["media"] = _parse_json(r["media"])
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
