import json
import re
import urllib.parse
from datetime import datetime
import os
import uuid
from fastapi import APIRouter, Request, UploadFile, File, Form
from pydantic import BaseModel
import psycopg2.extras
from database import get_conn, put_conn, conn_for, put_conn_named
from config import settings
from services import auth

router = APIRouter(prefix="/api/media", tags=["media"])


def _stamp(m: dict, user: str | None) -> None:
    """给媒体项盖上"谁挑的/何时" (采用/tier 时调用), 便于后续逐图显示挑选人。"""
    if user:
        m["selected_by"] = user
        m["selected_at"] = datetime.utcnow().isoformat() + "Z"


def _upload_to_oss(file_bytes: bytes, key: str, content_type: str) -> str:
    """上传字节到 ecjoy OSS, 返回公网 URL。"""
    import oss2
    auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)
    bucket = oss2.Bucket(auth, settings.oss_endpoint, settings.oss_bucket)
    bucket.put_object(key, file_bytes, headers={"Content-Type": content_type})
    host = settings.oss_endpoint.replace("https://", f"https://{settings.oss_bucket}.")
    return f"{host.rstrip('/')}/{key}"


@router.post("/upload")
async def upload_media(
    request: Request,
    character_id: int = Form(...),
    kind: str = Form("image"),
    label: str = Form(""),
    file: UploadFile = File(...),
):
    """手动给角色上传图片/视频 (进 Profile) 或音频 (设为角色 voice)。"""
    user = auth.user_from_request(request)
    raw = await file.read()
    if not raw:
        return {"status": "error", "message": "空文件"}
    limit = 300 if kind == "video" else 60
    if len(raw) > limit * 1024 * 1024:
        return {"status": "error", "message": f"文件超过 {limit}MB"}
    ext_default = {"image": ".png", "audio": ".mp3", "video": ".mp4"}.get(kind, ".bin")
    ext = os.path.splitext(file.filename or "")[1].lower() or ext_default
    key = f"candy_ai/manual_uploads/{character_id}/{uuid.uuid4().hex}{ext}"
    ctype = file.content_type or {"image": "image/png", "audio": "audio/mpeg",
                                  "video": "video/mp4"}.get(kind, "application/octet-stream")
    try:
        url = _upload_to_oss(raw, key, ctype)
    except Exception as e:
        return {"status": "error", "message": f"OSS 上传失败: {str(e)[:200]}"}

    _pool, conn = conn_for(cid=character_id)
    try:
        with conn.cursor() as cur:
            if kind == "audio":
                cur.execute("UPDATE characters SET voice_id = %s WHERE id = %s", (url, character_id))
            else:
                cur.execute("SELECT media FROM characters WHERE id = %s", (character_id,))
                row = cur.fetchone()
                media_list = _parse_json(row[0]) if row else []
                if not isinstance(media_list, list):
                    media_list = []
                item = {"url": url, "type": "video" if kind == "video" else "image",
                        "media_status": "online", "tier": "free", "source": "manual"}
                if label in ("costume", "scene", "prop"):
                    item["asset_kind"] = label   # 资产分区: 服装/场景/道具
                _stamp(item, user)
                media_list.append(item)
                cur.execute("UPDATE characters SET media = %s::json WHERE id = %s",
                            (json.dumps(media_list), character_id))
        conn.commit()
    finally:
        put_conn_named(_pool, conn)
    auth.log_action(user, f"upload:{kind}", str(character_id))
    return {"status": "ok", "url": url, "kind": kind}


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


def _move_to_end(media_list, urls):
    """Move media items whose url is in `urls` to the end of the array (keeping
    their relative order) so a moved/restored/adopted item appears LAST in its
    destination section (sections list items in media-array order)."""
    wanted = set(urls or [])
    moved, rest = [], []
    for m in media_list:
        (moved if isinstance(m, dict) and m.get("url") in wanted else rest).append(m)
    return rest + moved


@router.post("/status")
async def update_media_status(data: MediaStatusRequest):
    """Set per-media status: online, pre_release, or pending."""
    valid = {"online", "pre_release", "pending"}
    if data.media_status not in valid:
        return {"status": "error", "message": f"Invalid status. Must be one of: {valid}"}

    _pool, conn = conn_for(cid=data.character_id)
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
        put_conn_named(_pool, conn)


@router.post("/delete")
async def delete_media(data: DeleteRequest):
    """Delete a media entry.
    - data.hard=False (default, soft-delete): mark is_deleted=True in the media JSON, recoverable via /restore, goes to trash UI.
    - data.hard=True  (hard-delete):  permanently remove from JSON AND delete the underlying OSS object when the URL points at our managed bucket. Irreversible."""
    _pool, conn = conn_for(name=data.name)
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
                    cur.execute(
                        "DELETE FROM media_generation_tasks WHERE character_id = %s AND result_url = %s",
                        (cid, data.image_url),
                    )
                    if cur.rowcount:
                        conn.commit()
                        return {"status": "ok", "mode": "gen_task_deleted", "removed": cur.rowcount}
                    return {"status": "error", "message": "URL not found or already trashed"}
                media_list = _move_to_end(media_list, {data.image_url})
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
                    cur.execute(
                        "DELETE FROM media_generation_tasks WHERE character_id = %s AND result_url = %s",
                        (cid, data.image_url),
                    )
                    if cur.rowcount:
                        oss_ok, oss_msg = _delete_from_oss(data.image_url)
                        conn.commit()
                        return {"status": "ok", "mode": "gen_task_deleted", "oss_deleted": oss_ok}
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
        put_conn_named(_pool, conn)


@router.post("/restore")
async def restore(data: RestoreRequest):
    _pool, conn = conn_for(name=data.name)
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
                media_list = _move_to_end(media_list, {data.image_url})
                cur.execute(
                    "UPDATE characters SET media = %s::json WHERE id = %s",
                    (json.dumps(media_list), cid),
                )
        conn.commit()
        return {"status": "ok"}
    finally:
        put_conn_named(_pool, conn)


class RestoreBatchRequest(BaseModel):
    name: str
    image_urls: list[str]


@router.post("/restore-batch")
async def restore_batch(data: RestoreBatchRequest):
    """Restore multiple trashed items (un-delete), appended to the media tail."""
    _pool, conn = conn_for(name=data.name)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, media FROM characters WHERE name = %s", (data.name,))
            row = cur.fetchone()
            if not row:
                return {"status": "error", "message": f"Character '{data.name}' not found"}
            cid, media_raw = row
            media_list = _parse_json(media_raw) or []
            urls = set(data.image_urls or [])
            restored = 0
            for m in media_list:
                if isinstance(m, dict) and m.get("url") in urls and m.get("is_deleted"):
                    m.pop("is_deleted", None)
                    m.pop("deleted_at", None)
                    restored += 1
            media_list = _move_to_end(media_list, urls)
            cur.execute("UPDATE characters SET media = %s::json WHERE id = %s",
                        (json.dumps(media_list), cid))
        conn.commit()
        return {"status": "ok", "restored": restored}
    finally:
        put_conn_named(_pool, conn)


@router.post("/trash/empty")
async def empty_trash(data: EmptyTrashRequest):
    _pool, conn = conn_for(name=data.name)
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
        put_conn_named(_pool, conn)


class PendingBulkRequest(BaseModel):
    character_id: int


@router.post("/pending/adopt-all")
async def adopt_all_pending(data: PendingBulkRequest, request: Request):
    """Set all pending media items to online in one shot."""
    user = auth.user_from_request(request)
    _pool, conn = conn_for(cid=data.character_id)
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
                    _stamp(m, user)
                    count += 1
            cur.execute(
                "UPDATE characters SET media = %s::json WHERE id = %s",
                (json.dumps(media_list), cid),
            )
        conn.commit()
        auth.log_action(user, "adopt-all", str(data.character_id))
        return {"status": "ok", "adopted": count}
    finally:
        put_conn_named(_pool, conn)


@router.post("/pending/delete-all")
async def delete_all_pending(data: PendingBulkRequest):
    """Hard-delete all pending media items (remove from JSON + delete OSS objects)."""
    _pool, conn = conn_for(cid=data.character_id)
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
        put_conn_named(_pool, conn)

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


class BatchDeleteRequest(BaseModel):
    name: str
    image_urls: list[str]
    hard: bool = False


@router.post("/delete-batch")
async def delete_media_batch(data: BatchDeleteRequest):
    """Delete multiple media URLs for one character in a single DB write.
    soft (default) -> trash (recoverable); hard -> purge JSON + managed-OSS objects."""
    _pool, conn = conn_for(name=data.name)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, media FROM characters WHERE name = %s", (data.name,))
            row = cur.fetchone()
            if not row:
                return {"status": "error", "message": f"Character '{data.name}' not found"}
            cid, media_raw = row
            media_list = _parse_json(media_raw) or []
            urls = set(data.image_urls or [])
            if not urls:
                return {"status": "error", "message": "no image_urls provided"}

            if not data.hard:
                now = datetime.now().isoformat()
                matched = 0
                for m in media_list:
                    if isinstance(m, dict) and m.get("url") in urls and not m.get("is_deleted"):
                        m["is_deleted"] = True
                        m["deleted_at"] = now
                        matched += 1
                media_list = _move_to_end(media_list, urls)
                cur.execute("UPDATE characters SET media = %s::json WHERE id = %s",
                            (json.dumps(media_list), cid))
                conn.commit()
                print(f"[batch-soft-delete] cid={cid} trashed={matched}/{len(urls)}")
                return {"status": "ok", "mode": "soft", "trashed": matched}

            removed = [m for m in media_list
                       if isinstance(m, dict) and m.get("url") in urls]
            new_media = [m for m in media_list
                         if not (isinstance(m, dict) and m.get("url") in urls)]
            oss_ok = 0
            for m in removed:
                ok, _ = _delete_from_oss(m.get("url", ""))
                oss_ok += 1 if ok else 0
            cur.execute("UPDATE characters SET media = %s::json WHERE id = %s",
                        (json.dumps(new_media), cid))
            conn.commit()
            print(f"[batch-hard-delete] cid={cid} removed={len(removed)} oss_ok={oss_ok}")
            return {"status": "ok", "mode": "hard", "removed": len(removed), "oss_deleted": oss_ok}
    finally:
        put_conn_named(_pool, conn)


class SetTierRequest(BaseModel):
    name: str
    image_urls: list[str]
    tier: str  # "paid" | "free"


@router.post("/set-tier")
async def set_media_tier(data: SetTierRequest, request: Request):
    """Move images between Profile (free) and Paid tiers by tagging tier on the
    matching media JSON items."""
    if data.tier not in ("paid", "free"):
        return {"status": "error", "message": "tier must be paid|free"}
    user = auth.user_from_request(request)
    _pool, conn = conn_for(name=data.name)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, media FROM characters WHERE name = %s", (data.name,))
            row = cur.fetchone()
            if not row:
                return {"status": "error", "message": f"Character '{data.name}' not found"}
            cid, media_raw = row
            media_list = _parse_json(media_raw) or []
            urls = set(data.image_urls or [])
            changed = 0
            for m in media_list:
                if isinstance(m, dict) and m.get("url") in urls:
                    m["tier"] = data.tier
                    _stamp(m, user)
                    changed += 1
            media_list = _move_to_end(media_list, urls)
            cur.execute("UPDATE characters SET media = %s::json WHERE id = %s",
                        (json.dumps(media_list), cid))
        conn.commit()
        auth.log_action(user, f"set-tier:{data.tier}", data.name)
        print(f"[set-tier] cid={cid} tier={data.tier} changed={changed}/{len(urls)} by={user}")
        return {"status": "ok", "changed": changed}
    finally:
        put_conn_named(_pool, conn)


class AdoptBatchRequest(BaseModel):
    name: str
    image_urls: list[str]
    tier: str | None = None  # optionally also set tier while adopting


@router.post("/adopt-batch")
async def adopt_media_batch(data: AdoptBatchRequest, request: Request):
    """Adopt selected pending media (media_status -> online), optionally tagging
    a tier (paid/free) in the same write."""
    user = auth.user_from_request(request)
    _pool, conn = conn_for(name=data.name)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, media FROM characters WHERE name = %s", (data.name,))
            row = cur.fetchone()
            if not row:
                return {"status": "error", "message": f"Character '{data.name}' not found"}
            cid, media_raw = row
            media_list = _parse_json(media_raw) or []
            urls = set(data.image_urls or [])
            adopted = 0
            for m in media_list:
                if isinstance(m, dict) and m.get("url") in urls and not m.get("is_deleted"):
                    m["media_status"] = "online"
                    if data.tier in ("paid", "free"):
                        m["tier"] = data.tier
                    _stamp(m, user)
                    adopted += 1
            media_list = _move_to_end(media_list, urls)
            cur.execute("UPDATE characters SET media = %s::json WHERE id = %s",
                        (json.dumps(media_list), cid))
        conn.commit()
        auth.log_action(user, f"adopt:{data.tier or 'free'}", data.name)
        print(f"[adopt-batch] cid={cid} adopted={adopted}/{len(urls)} tier={data.tier} by={user}")
        return {"status": "ok", "adopted": adopted}
    finally:
        put_conn_named(_pool, conn)
