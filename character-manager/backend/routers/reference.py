import json
from fastapi import APIRouter
import psycopg2.extras
from database import get_conn, put_conn
from models import RefImageCreate, RefImageOut, RefImageDelete

router = APIRouter(prefix="/api/ref-images", tags=["reference"])


def _parse_json(val):
    if val is None:
        return None
    if isinstance(val, (list, dict)):
        return val
    try:
        return json.loads(val)
    except (json.JSONDecodeError, TypeError):
        return None


@router.get("", response_model=dict)
async def list_ref_images(character_id: int):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT id, character_id, vfe_frame_id, image_url, prompt,
                          dimensions, tags, style, description, created_at
                   FROM character_reference_images
                   WHERE character_id = %s ORDER BY created_at DESC""",
                (character_id,),
            )
            rows = cur.fetchall()
        for r in rows:
            if r.get("created_at"):
                r["created_at"] = r["created_at"].isoformat()
            r["dimensions"] = _parse_json(r.get("dimensions")) or {}
            r["tags"] = _parse_json(r.get("tags")) or []
        return {"total": len(rows), "items": rows}
    finally:
        put_conn(conn)


@router.post("", response_model=dict)
async def add_ref_image(data: RefImageCreate):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO character_reference_images
                    (character_id, vfe_frame_id, image_url, prompt, dimensions, tags, style, description)
                   VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s)
                   ON CONFLICT (character_id, image_url) DO UPDATE SET
                    prompt = EXCLUDED.prompt, dimensions = EXCLUDED.dimensions,
                    tags = EXCLUDED.tags, style = EXCLUDED.style,
                    description = EXCLUDED.description, vfe_frame_id = EXCLUDED.vfe_frame_id
                   RETURNING id""",
                (
                    data.character_id, data.vfe_frame_id, data.image_url, data.prompt,
                    json.dumps(data.dimensions), json.dumps(data.tags),
                    data.style, data.description,
                ),
            )
            rid = cur.fetchone()[0]
        conn.commit()
        return {"status": "ok", "id": rid}
    finally:
        put_conn(conn)


@router.post("/delete", response_model=dict)
async def delete_ref_image(data: RefImageDelete):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM character_reference_images WHERE id = %s", (data.id,))
        conn.commit()
        return {"status": "ok"}
    finally:
        put_conn(conn)
