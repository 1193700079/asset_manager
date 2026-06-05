import json
import re
import urllib.parse
from datetime import datetime
from fastapi import APIRouter
from pydantic import BaseModel
import psycopg2.extras
from database import get_conn, put_conn
from config import settings

router = APIRouter(prefix="/api/media", tags=["media"])


# Regex patterns for known CDN/OSS hosts that map to the OSS bucket.
# e.g. https://static.ecjoy.ai/candy_ai/girls/xxx.mp4  →  oss key = candy_ai/girls/xxx.mp4
_CDN_HOSTS_RE = re.compile(
    r"^https?://(?:static\.ecjoy\.ai|"
    + re.escape(settings.oss_bucket) + r"\.[^/]+\.aliyuncs\.com)/(.+)$",
    re.IGNORECASE,
)


def _url_to_oss_key(url: str) -> str | None:
    """Map a media URL to an OSS object key if it's hosted in our bucket, else None."""
    if not url:
        return None
    m = _CDN_HOSTS_RE.match(url.strip())
    if not m:
        return None
    return urllib.parse.unquote(m.group(1))


def _delete_from_oss(url: str) -> tuple[bool, str]:
    """Delete an object from OSS. Returns (success, message)."""
    key = _url_to_oss_key(url)
    if not key:
        return (False, f"URL not in managed OSS bucket: {url}")
    try:
        import oss2
        auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)
        bucket = oss2.Bucket(auth, settings.oss_endpoint, settings.oss_bucket)
        if bucket.object_exists(key):
            bucket.delete_object(key)
            print(f"[media-delete] OSS deleted: {key}")
            return (True, "deleted")
        else:
            print(f"[media-delete] OSS key not found (already gone?): {key}")
            return (True, "already-deleted")
    except Exception as e:
        print(f"[media-delete] OSS delete failed for {key}: {type(e).__name__}: {e}")
        return (False, f"oss-error: {e}")


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
    hard: bool = False  # False=soft-delete (trash, recoverable), True=hard-delete (purge DB+OSS)


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
async def delete_media(data: DeleteRequest):
    """Delete a media entry.
    - data.hard=False (default, soft-delete): mark is_deleted=True in the media JSON, recoverable via /restore, goes to trash UI.
    - data.hard=True  (hard-delete):  permanently remove from JSON AND delete the underlying OSS object when the URL points at our managed bucket. Irreversible."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, media FROM characters WHERE name = %s", (data.name,))
            row = cur.fetchone()
            if not row:
                return {"status": "error", "message": f"Character '{data.name}' not found"}
            cid, media_raw = row
            media_list = _parse_json(media_raw) or []

            if not data.hard:
                # ── SOFT DELETE ───────────────────────────────────────────
                now = datetime.now().isoformat()
                matched = 0
                for m in media_list:
                    if isinstance(m, dict) and m.get("url") == data.image_url and not m.get("is_deleted"):
                        m["is_deleted"] = True
                        m["deleted_at"] = now
                        matched += 1
                if not matched:
                    return {"status": "error", "message": "URL not found or already trashed"}
                cur.execute(
                    "UPDATE characters SET media = %s::json WHERE id = %s",
                    (json.dumps(media_list), cid),
                )
                print(f"[soft-delete] cid={cid} trashed={matched} url={data.image_url[:80]}")
                _soft_result = {"status": "ok", "mode": "soft", "trashed": matched}
            else:
                # ── HARD DELETE ──────────────────────────────────────────
                target = next(
                    (m for m in media_list
                     if isinstance(m, dict) and m.get("url") == data.image_url),
                    None,
                )
                if not target:
                    return {"status": "error", "message": "URL not found in media array"}

                new_media_list = [
                    m for m in media_list
                    if not (isinstance(m, dict) and m.get("url") == data.image_url)
                ]

                oss_ok, oss_msg = _delete_from_oss(data.image_url)

                cur.execute(
                    "UPDATE characters SET media = %s::json WHERE id = %s",
                    (json.dumps(new_media_list), cid),
                )
                print(f"[hard-delete] cid={cid} removed={len(media_list)-len(new_media_list)} oss_ok={oss_ok} url={data.image_url[:80]}")
                _soft_result = {
                    "status": "ok",
                    "mode": "hard",
                    "oss_deleted": oss_ok,
                    "oss_message": oss_msg,
                    "removed_entries": len(media_list) - len(new_media_list),
                }
        conn.commit()
        return _soft_result
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


class PendingBulkRequest(BaseModel):
    character_id: int


@router.post("/pending/adopt-all")
async def adopt_all_pending(data: PendingBulkRequest):
    """Set all pending media items to online in one shot."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, media FROM characters WHERE id = %s", (data.character_id,))
            row = cur.fetchone()
            if not row:
                return {"status": "error", "message": "Character not found"}
            cid, media_raw = row
            media_list = _parse_json(media_raw) or []
            count = 0
            for m in media_list:
                if isinstance(m, dict) and m.get("media_status") == "pending" and not m.get("is_deleted"):
                    m["media_status"] = "online"
                    count += 1
            cur.execute(
                "UPDATE characters SET media = %s::json WHERE id = %s",
                (json.dumps(media_list), cid),
            )
        conn.commit()
        return {"status": "ok", "adopted": count}
    finally:
        put_conn(conn)


@router.post("/pending/delete-all")
async def delete_all_pending(data: PendingBulkRequest):
    """Hard-delete all pending media items (remove from JSON + delete OSS objects)."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, media FROM characters WHERE id = %s", (data.character_id,))
            row = cur.fetchone()
            if not row:
                return {"status": "error", "message": "Character not found"}
            cid, media_raw = row
            media_list = _parse_json(media_raw) or []
            to_delete = [m for m in media_list if isinstance(m, dict) and m.get("media_status") == "pending" and not m.get("is_deleted")]
            remaining = [m for m in media_list if not (isinstance(m, dict) and m.get("media_status") == "pending" and not m.get("is_deleted"))]
            cur.execute(
                "UPDATE characters SET media = %s::json WHERE id = %s",
                (json.dumps(remaining), cid),
            )
        conn.commit()
    finally:
        put_conn(conn)

    # Delete OSS objects in background (don't block the response)
    import threading
    def _bg_oss_cleanup():
        for m in to_delete:
            url = m.get("url", "")
            if _url_to_oss_key(url):
                try:
                    _delete_from_oss(url)
                except Exception:
                    pass
    threading.Thread(target=_bg_oss_cleanup, daemon=True).start()

    return {"status": "ok", "deleted": len(to_delete)}
