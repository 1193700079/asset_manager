"""Audio library router — review-mode: assign N candidates (pending), pick one (online)."""
from fastapi import APIRouter
from pydantic import BaseModel

import psycopg2.extras

from database import get_conn, put_conn

router = APIRouter(prefix="/api/audio", tags=["audio"])


@router.get("/library")
async def list_audio(
    category: str | None = None,
    unassigned: bool = False,
    page: int = 1,
    limit: int = 30,
):
    conn = get_conn()
    try:
        offset = (max(1, page) - 1) * limit
        where_parts = ["1=1"]
        params: list = []

        if category:
            where_parts.append("category = %s")
            params.append(category)
        if unassigned:
            where_parts.append("assigned_to IS NULL AND (status IS NULL OR status = '')")

        where = " AND ".join(where_parts)

        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                f"SELECT count(*) as total FROM audio_library WHERE {where}",
                params,
            )
            total = cur.fetchone()["total"]

            cur.execute(
                f"""SELECT id, filename, category, duration, oss_url, assigned_to, status, created_at
                    FROM audio_library WHERE {where}
                    ORDER BY id DESC LIMIT %s OFFSET %s""",
                params + [limit, offset],
            )
            items = [dict(r) for r in cur.fetchall()]

        return {"status": "ok", "total": total, "page": page, "items": items}
    finally:
        put_conn(conn)


@router.get("/library/stats")
async def audio_stats():
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT category,
                       count(*) as total,
                       count(*) FILTER (WHERE assigned_to IS NULL AND (status IS NULL OR status = '')) as unassigned,
                       count(*) FILTER (WHERE status = 'pending') as pending,
                       count(*) FILTER (WHERE status = 'online') as online
                FROM audio_library
                GROUP BY category
                ORDER BY category
            """)
            rows = [dict(r) for r in cur.fetchall()]
        return {"status": "ok", "categories": rows}
    finally:
        put_conn(conn)


@router.get("/candidates/{character_id}")
async def get_candidates(character_id: int):
    """Get all pending/online audio candidates for a character."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT id, filename, category, duration, oss_url, status
                FROM audio_library
                WHERE assigned_to = %s AND status IN ('pending', 'online')
                ORDER BY status DESC, id
            """, (character_id,))
            items = [dict(r) for r in cur.fetchall()]
        return {"status": "ok", "items": items}
    finally:
        put_conn(conn)


class ConfirmRequest(BaseModel):
    audio_id: int
    character_id: int


@router.post("/confirm")
async def confirm_audio(data: ConfirmRequest):
    """Pick one candidate as online — sets voice_id on the character, rejects others."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT id, oss_url, assigned_to, status FROM audio_library WHERE id = %s",
                (data.audio_id,),
            )
            audio = cur.fetchone()
            if not audio:
                return {"status": "error", "message": "音频不存在"}
            if audio["assigned_to"] != data.character_id:
                return {"status": "error", "message": "该音频未分配给此角色"}

            # Set chosen one to online
            cur.execute(
                "UPDATE audio_library SET status = 'online' WHERE id = %s",
                (data.audio_id,),
            )
            # Reject all other pending for this character
            cur.execute(
                "UPDATE audio_library SET status = 'rejected', assigned_to = NULL WHERE assigned_to = %s AND id != %s AND status = 'pending'",
                (data.character_id, data.audio_id),
            )
            # Update character's voice_id
            cur.execute(
                "UPDATE characters SET voice_id = %s WHERE id = %s",
                (audio["oss_url"], data.character_id),
            )
        conn.commit()
        return {"status": "ok", "voice_id": audio["oss_url"]}
    finally:
        put_conn(conn)


@router.post("/reject/{audio_id}")
async def reject_audio(audio_id: int):
    """Reject a single candidate — frees it back to the pool."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE audio_library SET status = 'rejected', assigned_to = NULL WHERE id = %s",
                (audio_id,),
            )
        conn.commit()
        return {"status": "ok"}
    finally:
        put_conn(conn)


@router.post("/refresh-candidates/{character_id}")
async def refresh_candidates(character_id: int):
    """Reject all current pending candidates and assign 3 fresh random ones.
    Rejected audio never reappears for any character."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # Reject all current pending for this character
            cur.execute(
                "UPDATE audio_library SET status = 'rejected', assigned_to = NULL WHERE assigned_to = %s AND status = 'pending'",
                (character_id,),
            )
            rejected = cur.rowcount

            # Pick 3 new random unassigned audio (never picks rejected ones)
            cur.execute("""
                SELECT id FROM audio_library
                WHERE assigned_to IS NULL AND (status IS NULL OR status = '') AND oss_url IS NOT NULL
                ORDER BY random() LIMIT 3
            """)
            new_ids = [r["id"] for r in cur.fetchall()]

            for aid in new_ids:
                cur.execute(
                    "UPDATE audio_library SET assigned_to = %s, status = 'pending' WHERE id = %s",
                    (character_id, aid),
                )
        conn.commit()
        return {"status": "ok", "rejected": rejected, "added": len(new_ids)}
    finally:
        put_conn(conn)


class BatchAssignRequest(BaseModel):
    category: str | None = None
    per_character: int = 3


@router.post("/batch-assign")
async def batch_assign(data: BatchAssignRequest):
    """Assign N random pending audio to all male characters that don't have any candidates yet."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # Find male chars without any pending/online audio
            cur.execute("""
                SELECT c.id, c.name FROM characters c
                WHERE (c.is_deleted IS NULL OR c.is_deleted = FALSE)
                  AND c.creator_id = 'official'
                  AND c.category IN ('boyfriend', 'anime_male')
                  AND NOT EXISTS (
                    SELECT 1 FROM audio_library a
                    WHERE a.assigned_to = c.id AND a.status IN ('pending', 'online')
                  )
                ORDER BY c.name
            """)
            chars = cur.fetchall()

            # Category filter for available pool
            pool_where = "assigned_to IS NULL AND (status IS NULL OR status = '') AND oss_url IS NOT NULL"
            pool_params: list = []
            if data.category:
                pool_where += " AND category = %s"
                pool_params.append(data.category)

            assigned_total = 0
            for ch in chars:
                cur.execute(
                    f"SELECT id FROM audio_library WHERE {pool_where} ORDER BY random() LIMIT %s",
                    pool_params + [data.per_character],
                )
                picks = [r["id"] for r in cur.fetchall()]
                for aid in picks:
                    cur.execute(
                        "UPDATE audio_library SET assigned_to = %s, status = 'pending' WHERE id = %s",
                        (ch["id"], aid),
                    )
                assigned_total += len(picks)

        conn.commit()
        return {
            "status": "ok",
            "characters_processed": len(chars),
            "audio_assigned": assigned_total,
        }
    finally:
        put_conn(conn)
