"""
vfe_client — direct Supabase/PostgreSQL queries for the asset library.

Previously this module was an HTTP proxy to the VFE (Video Frame Extractor)
service running on port 8899.  Now it queries the ``saved_frames`` table in
Supabase directly — CM and VFE share the same database, so there is no need
for the intermediate HTTP hop.

All public function signatures and return types are preserved so that
callers (asset_library.py, batch_processing.py, generation.py) continue to
work without changes.
"""

import json
import re
from datetime import datetime, timezone

import psycopg2.extras

from database import get_conn_for, put_conn_for

# saved_frames table only exists in the ecjoy database. Always use that pool
# regardless of what X-Data-Source the frontend sends.
_VFE_DS = "ecjoy"
def _get():
    return get_conn_for(_VFE_DS)
def _put(conn):
    return put_conn_for(_VFE_DS, conn)


def _parse_json(val):
    """Parse a JSONB value that psycopg2 may return as str, dict, or None."""
    if val is None:
        return None
    if isinstance(val, (dict, list)):
        return val
    try:
        return json.loads(val)
    except (json.JSONDecodeError, TypeError):
        return None


def _to_iso(dt):
    """Convert a datetime to ISO-8601 string, or return None."""
    if dt is None:
        return None
    if isinstance(dt, datetime):
        return dt.astimezone(timezone.utc).isoformat()
    return str(dt)


def _build_image_url(oss_url: str | None, video_path: str) -> str:
    """Return oss_url if available, otherwise a local-serve proxy path."""
    if oss_url:
        return oss_url
    from urllib.parse import quote
    return f"/api/asset-library/serve?path={quote(video_path, safe='/')}"


# ---------------------------------------------------------------------------
# search_images
# ---------------------------------------------------------------------------
def _material_clause(material_type: str | None):
    """Return (sql_fragment, params) for filtering by material_type.
    'normal' → normal only; 'spicy'/'nsfw' → spicy (NULL defaults to spicy);
    None/'all' → no filter."""
    if material_type == "normal":
        return "material_type = %s", ["normal"]
    if material_type in ("spicy", "nsfw"):
        return "(material_type = 'spicy' OR material_type IS NULL)", []
    if material_type and material_type.startswith("scene_"):
        return "material_type = %s", [material_type]
    return None, []


async def search_images(
    tag: str | None = None,
    dimension: str | None = None,
    character_name: str | None = None,
    limit: int = 50,
    offset: int = 0,
    order: str | None = None,
    material_type: str | None = None,
) -> dict:
    """Search annotated images — mirrors VFE ``/api/swapface/search``."""
    conn = _get()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            where_clauses = ["format = 'image_annotation'"]
            params: list = []

            mt_sql, mt_params = _material_clause(material_type)
            if mt_sql:
                where_clauses.append(mt_sql)
                params.extend(mt_params)

            # Hide synthetic prompt-only rows (scene_* prompt pool, no real image)
            # from the browsable library; keep them only when explicitly querying a
            # scene_* material_type (batch generation prompt source).
            if not (material_type and material_type.startswith("scene_")):
                where_clauses.append("(oss_url IS NULL OR oss_url NOT LIKE 'scene_prompt://%%')")

            if dimension and tag:
                where_clauses.append("dimensions->>%s ILIKE %s")
                params.extend([dimension, f"%{tag}%"])
            elif tag:
                where_clauses.append("tags::text ILIKE %s")
                params.append(f"%{tag}%")

            if character_name:
                where_clauses.append("video_name ILIKE %s")
                params.append(f"%{character_name}%")

            where = "WHERE " + " AND ".join(where_clauses)

            # Count
            cur.execute(
                f"SELECT count(*) AS cnt FROM saved_frames {where}",
                params,
            )
            total = int(cur.fetchone()["cnt"])

            # Items
            order_clause = (
                "ORDER BY random()" if order == "random" else "ORDER BY created_at DESC"
            )
            cur.execute(
                f"""SELECT video_path, video_name, oss_url, prompt,
                           tags, dimensions, style, description,
                           model_id, created_at,
                           video_prompt, i2v_prompt
                    FROM saved_frames
                    {where}
                    {order_clause}
                    LIMIT %s OFFSET %s""",
                params + [int(limit), int(offset)],
            )
            rows = cur.fetchall()

            items = []
            for r in rows:
                oss = r.get("oss_url") or ""
                items.append({
                    "video_path": r["video_path"],
                    "video_name": r["video_name"],
                    "oss_url": oss,
                    "image_url": _build_image_url(oss, r["video_path"]),
                    "prompt": r.get("prompt"),
                    "tags": _parse_json(r.get("tags")) or [],
                    "dimensions": _parse_json(r.get("dimensions")) or {},
                    "style": r.get("style"),
                    "description": r.get("description"),
                    "model_id": r.get("model_id"),
                    "created_at": _to_iso(r.get("created_at")),
                    "video_prompt": r.get("video_prompt"),
                    "i2v_prompt": r.get("i2v_prompt"),
                })

            return {"total": total, "items": items}
    finally:
        _put(conn)


# ---------------------------------------------------------------------------
# get_faceswap_materials
# ---------------------------------------------------------------------------
async def get_faceswap_materials(limit: int = 10, exclude_used: bool = True) -> dict:
    """Random face_nsfw prescreened images — mirrors VFE ``/api/swapface/materials``."""
    conn = _get()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            where = """WHERE p.format = 'image_prescreen'
                AND p.description ~ '^\\s*\\{'
                AND (p.description::jsonb->>'category') = 'face_nsfw'"""
            if exclude_used:
                where += """
                AND NOT EXISTS (
                    SELECT 1 FROM faceswap_material_usage u
                    WHERE u.video_path = p.video_path
                )"""

            cur.execute(
                f"""SELECT count(*) AS cnt FROM saved_frames p {where}""",
            )
            total = int(cur.fetchone()["cnt"])

            cur.execute(
                f"""SELECT p.video_path, p.video_name, p.oss_url,
                           COALESCE(a.prompt, p.prompt) AS prompt,
                           p.tags, p.dimensions, p.description, p.created_at
                    FROM saved_frames p
                    LEFT JOIN saved_frames a
                      ON a.video_path = p.video_path
                     AND a.format = 'image_annotation'
                    {where}
                    ORDER BY random()
                    LIMIT %s""",
                [int(limit)],
            )
            rows = cur.fetchall()

            items = []
            for r in rows:
                oss = r.get("oss_url") or ""
                items.append({
                    "video_path": r["video_path"],
                    "video_name": r["video_name"],
                    "oss_url": oss,
                    "image_url": _build_image_url(oss, r["video_path"]),
                    "prompt": r.get("prompt"),
                    "tags": _parse_json(r.get("tags")) or [],
                    "dimensions": _parse_json(r.get("dimensions")) or {},
                    "description": r.get("description"),
                    "created_at": _to_iso(r.get("created_at")),
                })

            return {"total": total, "items": items}
    finally:
        _put(conn)


async def mark_faceswap_material_used(video_path: str, character_id: int | None = None, job_id: str | None = None) -> None:
    """Record a body material as used so future faceswap batches do not reuse it."""
    if not video_path:
        return
    conn = _get()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS faceswap_material_usage (
                    id BIGSERIAL PRIMARY KEY,
                    video_path TEXT NOT NULL,
                    character_id INTEGER,
                    job_id TEXT,
                    used_at TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE(video_path)
                )
            """)
            cur.execute("""
                INSERT INTO faceswap_material_usage (video_path, character_id, job_id)
                VALUES (%s, %s, %s)
                ON CONFLICT (video_path) DO NOTHING
            """, (video_path, character_id, job_id))
        conn.commit()
    finally:
        _put(conn)


# ---------------------------------------------------------------------------
# get_video_prompts
# ---------------------------------------------------------------------------
async def get_video_prompts(limit: int = 10) -> dict:
    """Random records with video_prompt + first-frame image — mirrors VFE ``/api/swapface/video-prompts``."""
    conn = _get()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            where = """WHERE video_prompt IS NOT NULL AND video_prompt <> ''
                AND oss_url IS NOT NULL AND oss_url <> ''"""

            cur.execute(
                f"SELECT count(*) AS cnt FROM saved_frames {where}",
            )
            total = int(cur.fetchone()["cnt"])

            cur.execute(
                f"""SELECT video_path, video_name, oss_url, prompt,
                           video_prompt, i2v_prompt,
                           tags, dimensions, created_at
                    FROM saved_frames
                    {where}
                    ORDER BY random()
                    LIMIT %s""",
                [int(limit)],
            )
            rows = cur.fetchall()

            items = []
            for r in rows:
                oss = r.get("oss_url") or ""
                items.append({
                    "video_path": r["video_path"],
                    "video_name": r["video_name"],
                    "oss_url": oss,
                    "image_url": _build_image_url(oss, r["video_path"]),
                    "prompt": r.get("prompt"),
                    "video_prompt": r.get("video_prompt"),
                    "i2v_prompt": r.get("i2v_prompt"),
                    "tags": _parse_json(r.get("tags")) or [],
                    "dimensions": _parse_json(r.get("dimensions")) or {},
                    "created_at": _to_iso(r.get("created_at")),
                })

            return {"total": total, "items": items}
    finally:
        _put(conn)


# ---------------------------------------------------------------------------
# get_tag_cloud
# ---------------------------------------------------------------------------
async def get_tag_cloud(material_type: str | None = None) -> dict:
    """Build a tag-cloud grouped by dimension — mirrors VFE ``/api/swapface/tag-cloud``."""
    conn = _get()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            mt_sql, mt_params = _material_clause(material_type)
            extra = (" AND " + mt_sql) if mt_sql else ""
            cur.execute(
                f"""SELECT dimensions FROM saved_frames
                    WHERE format = 'image_annotation' AND dimensions IS NOT NULL{extra}""",
                mt_params,
            )
            rows = cur.fetchall()

        total_images = len(rows)
        dim_tag_counts: dict[str, dict[str, int]] = {}

        _new_prefix_re = re.compile(r"^\[NEW\]\s*")

        for row in rows:
            dims = _parse_json(row["dimensions"])
            if not dims or not isinstance(dims, dict):
                continue
            for dim, tags in dims.items():
                if not isinstance(tags, list):
                    continue
                bucket = dim_tag_counts.setdefault(dim, {})
                for t in tags:
                    clean = _new_prefix_re.sub(
                        "", t if isinstance(t, str) else str(t)
                    )
                    bucket[clean] = bucket.get(clean, 0) + 1

        result: dict[str, list[dict]] = {}
        for dim, tag_map in dim_tag_counts.items():
            result[dim] = sorted(
                [{"tag": t, "count": c} for t, c in tag_map.items()],
                key=lambda x: x["count"],
                reverse=True,
            )

        return {"total_images": total_images, "dimensions": result}
    finally:
        _put(conn)


# ---------------------------------------------------------------------------
# get_stats
# ---------------------------------------------------------------------------
async def get_stats() -> dict:
    """Aggregate annotation stats — mirrors VFE ``/api/swapface/stats``."""
    conn = _get()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT count(*) AS cnt FROM saved_frames WHERE format = 'image_annotation'"
            )
            total = int(cur.fetchone()["cnt"])

            cur.execute(
                "SELECT DISTINCT video_name FROM saved_frames WHERE format = 'image_annotation'"
            )
            characters = [r["video_name"] for r in cur.fetchall()]

            cur.execute(
                """SELECT dimensions FROM saved_frames
                   WHERE format = 'image_annotation' AND dimensions IS NOT NULL"""
            )
            dim_rows = cur.fetchall()

        tag_counts: dict[str, int] = {}
        _new_prefix_re = re.compile(r"^\[NEW\]\s*")
        for row in dim_rows:
            dims = _parse_json(row["dimensions"])
            if not dims or not isinstance(dims, dict):
                continue
            for _dim, tags in dims.items():
                if not isinstance(tags, list):
                    continue
                for t in tags:
                    clean = _new_prefix_re.sub(
                        "", t if isinstance(t, str) else str(t)
                    )
                    tag_counts[clean] = tag_counts.get(clean, 0) + 1

        top_tags = sorted(
            [{"tag": t, "count": c} for t, c in tag_counts.items()],
            key=lambda x: x["count"],
            reverse=True,
        )[:50]

        return {"total": total, "characters": characters, "top_tags": top_tags}
    finally:
        _put(conn)


# ---------------------------------------------------------------------------
# skip_image
# ---------------------------------------------------------------------------
async def skip_image(image_path: str) -> dict:
    """Mark an image as skipped — mirrors VFE ``/api/image/skip``."""
    conn = _get()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """DELETE FROM saved_frames
                   WHERE video_path = %s
                     AND format IN ('image_annotation', 'image_skip')""",
                (image_path,),
            )
            import os
            name = os.path.basename(image_path)
            cur.execute(
                """INSERT INTO saved_frames
                       (video_path, video_name, timestamp, oss_url, oss_key,
                        status, format, description, created_at)
                   VALUES (%s, %s, -1, '', '', 'skipped', 'image_skip',
                           'Manual skip', NOW())""",
                (image_path, name),
            )
        conn.commit()
        return {"success": True}
    except Exception as e:
        conn.rollback()
        return {"success": False, "error": str(e)}
    finally:
        _put(conn)


# ---------------------------------------------------------------------------
# ping (kept for backward-compat)
# ---------------------------------------------------------------------------
async def ping(timeout: float = 3.0) -> dict:
    """Liveness check.

    Previously checked whether VFE was reachable via HTTP.  Now that we read
    directly from Supabase (which shares the same connection pool as the rest
    of CM), we simply verify that a DB connection is available.
    """
    try:
        conn = _get()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
            return {"ok": True}
        finally:
            _put(conn)
    except Exception as e:
        return {"ok": False, "error": f"DB 不可达: {type(e).__name__}: {e}"}
