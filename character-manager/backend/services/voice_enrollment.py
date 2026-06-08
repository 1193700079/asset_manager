"""Voice enrollment service — registers audio_library voices via CosyVoice API.

Single-character and batch modes. Batch runs in a background thread.
"""
import threading
import time
import json
import os
from datetime import datetime, timezone

import dashscope
from dashscope.audio.tts_v2 import VoiceEnrollmentService

import psycopg2.extras
from database import get_conn_for, put_conn_for

COSYVOICE_API_KEY = os.getenv("COSYVOICE_API_KEY", "sk-57a3672409034da19a910f6764083876")
TARGET_MODEL = "cosyvoice-v3.5-plus"
LANGUAGE_HINTS = ["zh"]
POLL_INTERVAL = 5
MAX_POLL_ATTEMPTS = 30
RATE_LIMIT_SLEEP = 2

_lock = threading.Lock()
_batch_job: dict | None = None


def is_valid_cosyvoice_id(voice_id: str | None) -> bool:
    if not voice_id:
        return False
    return voice_id.startswith("cosyvoice-")


def _make_service() -> VoiceEnrollmentService:
    dashscope.api_key = COSYVOICE_API_KEY
    dashscope.base_http_api_url = "https://dashscope.aliyuncs.com/api/v1"
    try:
        dashscope.base_websocket_api_url = "wss://dashscope.aliyuncs.com/api-ws/v1/inference/"
    except Exception:
        pass
    return VoiceEnrollmentService()


def _sanitize_prefix(name: str) -> str:
    safe = "".join(x for x in name if x.isalnum())[:9].lower()
    return safe or "myvoice"


def enroll_voice(audio_url: str, prefix: str, log_fn=print) -> str | None:
    safe_prefix = _sanitize_prefix(prefix)
    log_fn(f"  [Enroll] prefix={safe_prefix}, url={audio_url}")

    service = _make_service()
    try:
        voice_id = service.create_voice(
            target_model=TARGET_MODEL,
            prefix=safe_prefix,
            url=audio_url,
            language_hints=LANGUAGE_HINTS,
        )
        log_fn(f"  [Enroll] Created: {voice_id}")
    except Exception as e:
        log_fn(f"  [Enroll] ERROR: {e}")
        return None

    for attempt in range(1, MAX_POLL_ATTEMPTS + 1):
        time.sleep(POLL_INTERVAL)
        try:
            info = service.query_voice(voice_id=voice_id)
            status = info.get("status") if isinstance(info, dict) else None
            log_fn(f"  [Enroll] Poll {attempt}/{MAX_POLL_ATTEMPTS}: status={status}")
            if status == "OK":
                log_fn(f"  [Enroll] SUCCESS: {voice_id}")
                return voice_id
            elif status == "UNDEPLOYED":
                log_fn(f"  [Enroll] FAILED: UNDEPLOYED")
                return None
        except Exception as e:
            log_fn(f"  [Enroll] Poll error: {e}")

    log_fn(f"  [Enroll] TIMEOUT after {MAX_POLL_ATTEMPTS * POLL_INTERVAL}s")
    return None


def enroll_character(character_id: int, ds: str = "ecjoy", log_fn=print) -> dict:
    conn = get_conn_for(ds)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT a.id as audio_id, a.filename, a.oss_url, a.status as audio_status,
                       c.id as char_id, c.name, c.voice_id
                FROM audio_library a
                JOIN characters c ON c.id = a.assigned_to
                WHERE a.assigned_to = %s
                  AND a.status = 'online'
                  AND a.oss_url IS NOT NULL
                ORDER BY a.id
                LIMIT 1
            """, (character_id,))
            row = cur.fetchone()

            if not row:
                return {"status": "error", "message": "没有 online 状态的音频"}

            if is_valid_cosyvoice_id(row["voice_id"]):
                return {"status": "skipped", "message": "已有 CosyVoice 语音", "voice_id": row["voice_id"]}

            log_fn(f"Character: {row['name']} (id={row['char_id']})")
            log_fn(f"Audio: {row['filename']} -> {row['oss_url']}")

            voice_id = enroll_voice(row["oss_url"], prefix=row["name"], log_fn=log_fn)

            if voice_id:
                cur.execute("UPDATE characters SET voice_id = %s WHERE id = %s", (voice_id, character_id))
                conn.commit()
                return {"status": "ok", "voice_id": voice_id, "character": row["name"]}
            else:
                return {"status": "error", "message": "CosyVoice 注册失败"}
    finally:
        put_conn_for(ds, conn)


def _batch_worker(ds: str, char_ids: list[int] | None):
    global _batch_job

    conn = get_conn_for(ds)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if char_ids:
                placeholders = ",".join(["%s"] * len(char_ids))
                cur.execute(f"""
                    SELECT a.id as audio_id, a.filename, a.oss_url,
                           c.id as char_id, c.name, c.voice_id
                    FROM audio_library a
                    JOIN characters c ON c.id = a.assigned_to
                    WHERE a.assigned_to IN ({placeholders})
                      AND a.status = 'online'
                      AND a.oss_url IS NOT NULL
                    ORDER BY c.name
                """, char_ids)
            else:
                cur.execute("""
                    SELECT a.id as audio_id, a.filename, a.oss_url,
                           c.id as char_id, c.name, c.voice_id
                    FROM audio_library a
                    JOIN characters c ON c.id = a.assigned_to
                    WHERE a.status = 'online'
                      AND a.assigned_to IS NOT NULL
                      AND a.oss_url IS NOT NULL
                    ORDER BY c.name
                """)
            records = [dict(r) for r in cur.fetchall()]
    finally:
        put_conn_for(ds, conn)

    eligible = [r for r in records if not is_valid_cosyvoice_id(r["voice_id"])]

    with _lock:
        _batch_job["total"] = len(eligible)
        _batch_job["skipped"] = len(records) - len(eligible)
        _batch_job["status"] = "running"

    for i, rec in enumerate(eligible):
        with _lock:
            if _batch_job.get("status") == "stopping":
                _batch_job["status"] = "stopped"
                return
            _batch_job["current"] = i + 1
            _batch_job["current_name"] = rec["name"]

        def log(msg):
            with _lock:
                _batch_job.setdefault("logs", []).append(msg)
                if len(_batch_job["logs"]) > 200:
                    _batch_job["logs"] = _batch_job["logs"][-200:]

        log(f"[{i+1}/{len(eligible)}] {rec['name']}")
        voice_id = enroll_voice(rec["oss_url"], prefix=rec["name"], log_fn=log)

        if voice_id:
            conn2 = get_conn_for(ds)
            try:
                with conn2.cursor() as cur2:
                    cur2.execute("UPDATE characters SET voice_id = %s WHERE id = %s", (voice_id, rec["char_id"]))
                conn2.commit()
            finally:
                put_conn_for(ds, conn2)
            with _lock:
                _batch_job["succeeded"] += 1
            log(f"  -> {voice_id}")
        else:
            with _lock:
                _batch_job["failed"] += 1
            log(f"  -> FAILED")

        if i < len(eligible) - 1:
            time.sleep(RATE_LIMIT_SLEEP)

    with _lock:
        _batch_job["status"] = "done"
        _batch_job["finished_at"] = datetime.now(timezone.utc).isoformat()


def start_batch(ds: str = "ecjoy", char_ids: list[int] | None = None) -> dict:
    global _batch_job

    with _lock:
        if _batch_job and _batch_job.get("status") == "running":
            return {"status": "error", "message": "已有批处理任务在运行"}

        _batch_job = {
            "status": "starting",
            "total": 0,
            "current": 0,
            "current_name": "",
            "succeeded": 0,
            "failed": 0,
            "skipped": 0,
            "logs": [],
            "started_at": datetime.now(timezone.utc).isoformat(),
            "finished_at": None,
        }

    t = threading.Thread(target=_batch_worker, args=(ds, char_ids), daemon=True)
    t.start()

    return {"status": "ok", "message": "批处理已启动"}


def get_batch_status() -> dict | None:
    with _lock:
        if not _batch_job:
            return None
        return {
            "status": _batch_job["status"],
            "total": _batch_job["total"],
            "current": _batch_job["current"],
            "current_name": _batch_job.get("current_name", ""),
            "succeeded": _batch_job["succeeded"],
            "failed": _batch_job["failed"],
            "skipped": _batch_job["skipped"],
            "started_at": _batch_job.get("started_at"),
            "finished_at": _batch_job.get("finished_at"),
            "logs": _batch_job.get("logs", [])[-50:],
        }


def stop_batch() -> dict:
    with _lock:
        if not _batch_job or _batch_job.get("status") != "running":
            return {"status": "error", "message": "没有运行中的批处理"}
        _batch_job["status"] = "stopping"
    return {"status": "ok", "message": "正在停止"}
