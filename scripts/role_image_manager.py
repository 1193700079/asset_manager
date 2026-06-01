import http.server
import json
import os
import threading
from urllib.parse import urlparse, parse_qs
from datetime import datetime

import psycopg2
import psycopg2.pool
import psycopg2.extras

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:YRQ21163x%21ecjoy"
    "@db.agnithttoxexijxkksbv.supabase.co:5432/postgres"
)
PORT = int(os.environ.get("PORT", 9090))
LOG_FILE = os.environ.get("LOG_FILE", "swapface_manager.log")

pool = None
_index_cache = None
_index_lock = threading.Lock()


def log(msg):
    ts = datetime.now().isoformat()
    print(f"[{ts}] {msg}")
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except OSError:
        pass


def get_conn():
    return pool.getconn()


def put_conn(conn):
    pool.putconn(conn)


def _parse_json(val):
    if val is None:
        return None
    if isinstance(val, (list, dict)):
        return val
    try:
        return json.loads(val)
    except (json.JSONDecodeError, TypeError):
        return None


def _update_media_for_char(cur, cid, media_list):
    cur.execute("UPDATE characters SET media = %s::json WHERE id = %s",
                (json.dumps(media_list), cid))


def load_index():
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT id, name, category, description, attributes, media,
                       content_rating, sort_priority
                FROM characters
                WHERE (is_deleted IS NULL OR is_deleted = FALSE)
                ORDER BY name
            """)
            chars = cur.fetchall()

            cur.execute("""
                SELECT character_id, result_url, task_type, status, created_at
                FROM media_generation_tasks
                WHERE status = 'completed' AND result_url IS NOT NULL
                ORDER BY created_at DESC
            """)
            gen_tasks = cur.fetchall()

        gen_by_char = {}
        for t in gen_tasks:
            cid = t["character_id"]
            if cid not in gen_by_char:
                gen_by_char[cid] = []
            gen_by_char[cid].append({
                "url": t["result_url"],
                "type": t["task_type"],
                "created_at": t["created_at"].isoformat() if t["created_at"] else None,
            })

        index = {}
        for c in chars:
            name = c["name"]
            if not name:
                continue

            attrs = _parse_json(c["attributes"]) or {}
            media_list = _parse_json(c["media"]) or []

            active = [m for m in media_list if not m.get("is_deleted")]
            trashed = [m for m in media_list if m.get("is_deleted")]

            profile_images = [m["url"] for m in active if m.get("type") == "image" and m.get("url")]
            profile_videos = [m["url"] for m in active if m.get("type") == "video" and m.get("url")]
            swapface_images = [m["url"] for m in active if m.get("type") == "swapface_image" and m.get("url")]

            trash_images = [m["url"] for m in trashed if m.get("type") == "image" and m.get("url")]
            trash_videos = [m["url"] for m in trashed if m.get("type") == "video" and m.get("url")]
            trash_generated = [m["url"] for m in trashed if m.get("type") == "swapface_image" and m.get("url")]

            gen_images = [g["url"] for g in gen_by_char.get(c["id"], []) if g["type"] == "image"]
            generated_images = list(dict.fromkeys(swapface_images + gen_images))

            index[name] = {
                "id": c["id"],
                "category": c["category"] or "uncategorized",
                "description": c["description"] or "",
                "attributes": attrs,
                "content_rating": c["content_rating"] or "sfw",
                "profile_images": profile_images,
                "profile_videos": profile_videos,
                "generated_images": generated_images,
                "all_images": profile_images + generated_images,
                "trash_images": trash_images,
                "trash_videos": trash_videos,
                "trash_generated": trash_generated,
                "trash_all": trash_images + trash_videos + trash_generated,
            }
        return index
    finally:
        put_conn(conn)


def rebuild_index():
    global _index_cache
    with _index_lock:
        _index_cache = load_index()
    return _index_cache


def get_cached_index():
    global _index_cache
    if _index_cache is None:
        with _index_lock:
            if _index_cache is None:
                _index_cache = load_index()
    return _index_cache


class Handler(http.server.BaseHTTPRequestHandler):

    def _json_response(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length).decode("utf-8")) if length else {}

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ("/", "/index.html"):
            body = PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        elif path == "/api/index":
            self._json_response(get_cached_index())

        elif path == "/api/rebuild":
            idx = rebuild_index()
            self._json_response({"status": "ok", "count": len(idx)})

        elif path == "/api/characters":
            qs = parse_qs(parsed.query)
            category = qs.get("category", [None])[0]
            conn = get_conn()
            try:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    if category:
                        cur.execute("""
                            SELECT id, name, category, description, attributes, media,
                                   content_rating, sort_priority
                            FROM characters
                            WHERE (is_deleted IS NULL OR is_deleted = FALSE)
                              AND category = %s
                            ORDER BY name
                        """, (category,))
                    else:
                        cur.execute("""
                            SELECT id, name, category, description, attributes, media,
                                   content_rating, sort_priority
                            FROM characters
                            WHERE (is_deleted IS NULL OR is_deleted = FALSE)
                            ORDER BY name
                        """)
                    rows = cur.fetchall()
                for r in rows:
                    r["attributes"] = _parse_json(r["attributes"])
                    r["media"] = _parse_json(r["media"])
                self._json_response(rows)
            finally:
                put_conn(conn)

        elif path == "/api/categories":
            conn = get_conn()
            try:
                with conn.cursor() as cur:
                    cur.execute("""
                        SELECT category, count(*) FROM characters
                        WHERE (is_deleted IS NULL OR is_deleted = FALSE)
                        GROUP BY category ORDER BY count(*) DESC
                    """)
                    rows = cur.fetchall()
                self._json_response([{"category": r[0], "count": r[1]} for r in rows])
            finally:
                put_conn(conn)

        elif path == "/api/generation_tasks":
            qs = parse_qs(parsed.query)
            char_id = qs.get("character_id", [None])[0]
            conn = get_conn()
            try:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    if char_id:
                        cur.execute("""
                            SELECT * FROM media_generation_tasks
                            WHERE character_id = %s ORDER BY created_at DESC LIMIT 50
                        """, (char_id,))
                    else:
                        cur.execute("""
                            SELECT * FROM media_generation_tasks
                            ORDER BY created_at DESC LIMIT 50
                        """)
                    rows = cur.fetchall()
                for r in rows:
                    for k in ("created_at", "updated_at"):
                        if r.get(k):
                            r[k] = r[k].isoformat()
                self._json_response(rows)
            finally:
                put_conn(conn)

        elif path == "/api/ref-images":
            qs = parse_qs(parsed.query)
            char_id = qs.get("character_id", [None])[0]
            if not char_id:
                self._json_response({"error": "character_id required"}, 400)
                return
            conn = get_conn()
            try:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    cur.execute("""
                        SELECT id, character_id, vfe_frame_id, image_url, prompt,
                               dimensions, tags, style, description, created_at
                        FROM character_reference_images
                        WHERE character_id = %s
                        ORDER BY created_at DESC
                    """, (char_id,))
                    rows = cur.fetchall()
                for r in rows:
                    if r.get("created_at"):
                        r["created_at"] = r["created_at"].isoformat()
                    r["dimensions"] = _parse_json(r.get("dimensions")) or {}
                    r["tags"] = _parse_json(r.get("tags")) or []
                self._json_response({"total": len(rows), "items": rows})
            finally:
                put_conn(conn)

        elif path == "/api/vfe/search":
            import urllib.request
            vfe_url = os.environ.get("VFE_URL", "http://localhost:3001")
            qs = parse_qs(parsed.query)
            params = []
            for k in ("tag", "dimension", "character_name", "limit", "offset"):
                v = qs.get(k, [None])[0]
                if v:
                    params.append(f"{k}={v}")
            query_str = "&".join(params) if params else "limit=50"
            try:
                req = urllib.request.Request(f"{vfe_url}/api/swapface/search?{query_str}")
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = json.loads(resp.read().decode())
                self._json_response(data)
            except Exception as e:
                self._json_response({"total": 0, "items": [], "error": str(e)})

        elif path == "/api/vfe/annotated":
            import urllib.request
            vfe_url = os.environ.get("VFE_URL", "http://localhost:3001")
            qs = parse_qs(parsed.query)
            limit = qs.get("limit", ["100"])[0]
            try:
                req = urllib.request.Request(f"{vfe_url}/api/swapface/search?limit={limit}")
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = json.loads(resp.read().decode())
                self._json_response(data)
            except Exception as e:
                self._json_response({"total": 0, "items": [], "error": str(e)})

        elif path == "/api/characters/list":
            conn = get_conn()
            try:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    cur.execute("""
                        SELECT id, name, category FROM characters
                        WHERE (is_deleted IS NULL OR is_deleted = FALSE)
                        ORDER BY name
                    """)
                    rows = cur.fetchall()
                self._json_response(rows)
            finally:
                put_conn(conn)

        elif path == "/api/asset-library/tags":
            import urllib.request
            vfe_url = os.environ.get("VFE_URL", "http://localhost:3001")
            try:
                req = urllib.request.Request(f"{vfe_url}/api/swapface/tag-cloud")
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = json.loads(resp.read().decode())
                self._json_response(data)
            except Exception as e:
                self._json_response({"total_images": 0, "dimensions": {}, "error": str(e)})

        elif path == "/api/asset-library/images":
            import urllib.request
            vfe_url = os.environ.get("VFE_URL", "http://localhost:3001")
            qs = parse_qs(parsed.query)
            params = []
            for k in ("tag", "dimension", "limit", "offset"):
                v = qs.get(k, [None])[0]
                if v:
                    params.append(f"{k}={v}")
            query_str = "&".join(params) if params else "limit=50"
            try:
                req = urllib.request.Request(f"{vfe_url}/api/swapface/search?{query_str}")
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = json.loads(resp.read().decode())
                self._json_response(data)
            except Exception as e:
                self._json_response({"total": 0, "items": [], "error": str(e)})

        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        global _index_cache
        data = self._read_body()
        path = urlparse(self.path).path

        if path == "/api/delete":
            name = data.get("name", "")
            img_url = data.get("image_url", "")
            log(f"[SOFT-DELETE] name={name}, url={img_url}")

            conn = get_conn()
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT id, media FROM characters WHERE name = %s", (name,))
                    row = cur.fetchone()
                    if row:
                        cid, media_raw = row
                        media_list = _parse_json(media_raw) or []
                        now = datetime.now().isoformat()
                        for m in media_list:
                            if m.get("url") == img_url and not m.get("is_deleted"):
                                m["is_deleted"] = True
                                m["deleted_at"] = now
                        _update_media_for_char(cur, cid, media_list)
                conn.commit()
            finally:
                put_conn(conn)

            _index_cache = None

            self._json_response({"status": "ok"})

        elif path == "/api/restore":
            name = data.get("name", "")
            img_url = data.get("image_url", "")
            log(f"[RESTORE] name={name}, url={img_url}")

            conn = get_conn()
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT id, media FROM characters WHERE name = %s", (name,))
                    row = cur.fetchone()
                    if row:
                        cid, media_raw = row
                        media_list = _parse_json(media_raw) or []
                        for m in media_list:
                            if m.get("url") == img_url:
                                m.pop("is_deleted", None)
                                m.pop("deleted_at", None)
                        _update_media_for_char(cur, cid, media_list)
                conn.commit()
            finally:
                put_conn(conn)

            _index_cache = None

            self._json_response({"status": "ok"})

        elif path == "/api/trash/empty":
            name = data.get("name", "")
            log(f"[EMPTY-TRASH] name={name}")

            conn = get_conn()
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT id, media FROM characters WHERE name = %s", (name,))
                    row = cur.fetchone()
                    if row:
                        cid, media_raw = row
                        media_list = _parse_json(media_raw) or []
                        media_list = [m for m in media_list if not m.get("is_deleted")]
                        _update_media_for_char(cur, cid, media_list)
                conn.commit()
            finally:
                put_conn(conn)

            _index_cache = None

            self._json_response({"status": "ok"})

        elif path == "/api/ref-images":
            character_id = data.get("character_id")
            image_url = data.get("image_url", "")
            if not character_id or not image_url:
                self._json_response({"error": "character_id and image_url required"}, 400)
                return
            prompt = data.get("prompt", "")
            dimensions = data.get("dimensions", {})
            tags = data.get("tags", [])
            style = data.get("style", "")
            description = data.get("description", "")
            vfe_frame_id = data.get("vfe_frame_id")
            conn = get_conn()
            try:
                with conn.cursor() as cur:
                    cur.execute("""
                        INSERT INTO character_reference_images
                            (character_id, vfe_frame_id, image_url, prompt, dimensions, tags, style, description)
                        VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s)
                        ON CONFLICT (character_id, image_url) DO UPDATE SET
                            prompt = EXCLUDED.prompt,
                            dimensions = EXCLUDED.dimensions,
                            tags = EXCLUDED.tags,
                            style = EXCLUDED.style,
                            description = EXCLUDED.description,
                            vfe_frame_id = EXCLUDED.vfe_frame_id
                        RETURNING id
                    """, (character_id, vfe_frame_id, image_url, prompt,
                          json.dumps(dimensions), json.dumps(tags), style, description))
                    rid = cur.fetchone()[0]
                conn.commit()
                log(f"[REF-IMAGE] added id={rid} char_id={character_id}")
                self._json_response({"status": "ok", "id": rid})
            finally:
                put_conn(conn)

        elif path == "/api/ref-images/delete":
            ref_id = data.get("id")
            if not ref_id:
                self._json_response({"error": "id required"}, 400)
                return
            conn = get_conn()
            try:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM character_reference_images WHERE id = %s", (ref_id,))
                conn.commit()
                log(f"[REF-IMAGE] deleted id={ref_id}")
                self._json_response({"status": "ok"})
            finally:
                put_conn(conn)

        elif path == "/api/characters":
            name = data.get("name", "")
            category = data.get("category", "uncategorized")
            description = data.get("description", "")
            attributes = data.get("attributes", {})
            media = data.get("media", [])
            if not name:
                self._json_response({"error": "name required"}, 400)
                return
            conn = get_conn()
            try:
                with conn.cursor() as cur:
                    cur.execute("""
                        INSERT INTO characters (name, category, description, attributes, media)
                        VALUES (%s, %s, %s, %s::json, %s::json)
                        ON CONFLICT DO NOTHING
                        RETURNING id
                    """, (name, category, description,
                          json.dumps(attributes), json.dumps(media)))
                    row = cur.fetchone()
                conn.commit()
                cid = row[0] if row else None
                log(f"[CHARACTER] upsert name={name} id={cid}")
                self._json_response({"status": "ok", "id": cid})
            finally:
                put_conn(conn)

        elif path == "/api/characters/delete":
            name = data.get("name", "")
            conn = get_conn()
            try:
                with conn.cursor() as cur:
                    cur.execute("""
                        UPDATE characters SET is_deleted = TRUE, deleted_at = NOW()
                        WHERE name = %s
                    """, (name,))
                conn.commit()
                log(f"[CHARACTER] soft-deleted name={name}")
                self._json_response({"status": "ok"})
            finally:
                put_conn(conn)

        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        log(format % args)


PAGE = r"""<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>Character Manager</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#1a1a2e;color:#eee}
.sidebar{width:280px;height:100vh;overflow-y:auto;position:fixed;left:0;top:0;background:#16213e;border-right:1px solid #0f3460}
.sidebar h2{padding:12px 16px;background:#0f3460;font-size:14px;position:sticky;top:0;z-index:1}
.search-box{padding:8px 12px;position:sticky;top:42px;background:#16213e;z-index:1}
.search-box input{width:100%;padding:6px 10px;background:#0f3460;border:1px solid #1a3a6e;color:#eee;border-radius:4px;font-size:13px}
.cat-filter{padding:4px 12px 8px;display:flex;gap:4px;flex-wrap:wrap}
.cat-btn{background:#0f3460;color:#aaa;border:none;padding:3px 8px;border-radius:10px;cursor:pointer;font-size:11px}
.cat-btn.active{background:#e94560;color:#fff}
.char-item{padding:10px 16px;cursor:pointer;border-bottom:1px solid #0f3460;transition:background .15s;display:flex;gap:10px;align-items:center}
.char-item:hover{background:#0f3460}
.char-item.active{background:#e94560}
.char-thumb{width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0;background:#0f3460}
.char-meta{overflow:hidden}
.char-name{font-size:13px;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.char-info{font-size:11px;color:#aaa;margin-top:2px}
.main{margin-left:280px;padding:20px}
.header{margin-bottom:20px}
.header h1{font-size:24px}
.header .desc{font-size:13px;color:#aaa;margin-top:6px;max-width:700px;line-height:1.5}
.header .attrs{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.attr-tag{background:#0f3460;padding:3px 10px;border-radius:12px;font-size:11px}
.section-title{font-size:14px;color:#aaa;margin:16px 0 8px;border-bottom:1px solid #0f3460;padding-bottom:4px;display:flex;align-items:center;gap:8px}
.section-title .trash-actions{margin-left:auto;display:flex;gap:6px}
.grid{columns:220px;column-gap:10px}
.card{position:relative;break-inside:avoid;margin-bottom:10px;background:#16213e;border-radius:8px;overflow:hidden;border:1px solid #0f3460}
.card img,.card video{width:100%;height:auto;display:block;cursor:pointer}
.card .del-btn{position:absolute;top:4px;right:4px;background:rgba(233,69,96,0.85);color:#fff;border:none;width:22px;height:22px;border-radius:50%;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s}
.card:hover .del-btn{opacity:1}
.card .badge{position:absolute;top:4px;left:4px;background:rgba(15,52,96,0.85);color:#eee;padding:2px 6px;border-radius:3px;font-size:10px}
.card .img-name{padding:4px 6px;font-size:10px;color:#aaa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card.trashed{opacity:0.6;border-color:#e94560}
.card.trashed .del-btn{background:rgba(46,204,113,0.9)}
.stats{font-size:13px;color:#aaa;margin-top:4px}
.empty{color:#666;font-size:14px;padding:40px 0}
.modal{display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.95);z-index:9999;overflow:auto}
.modal .modal-content{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)}
.modal .modal-content img{max-width:95vw;max-height:95vh;display:block}
.modal .modal-content video{max-width:95vw;max-height:95vh;display:block}
.modal .modal-del{position:fixed;top:20px;right:20px;background:#e94560;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;z-index:10000}
.modal .modal-close{position:fixed;top:20px;left:20px;background:#0f3460;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;z-index:10000}
.toolbar{padding:8px 12px;display:flex;gap:6px}
.toolbar button{background:#0f3460;color:#eee;border:none;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px}
.toolbar button:hover{background:#e94560}
.btn-sm{background:#0f3460;color:#eee;border:none;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px}
.btn-sm:hover{background:#e94560}
.btn-sm.green{background:#27ae60}
.btn-sm.green:hover{background:#2ecc71}
.btn-sm.red{background:#c0392b}
.btn-sm.red:hover{background:#e74c3c}
.trash-toggle{background:none;border:1px solid #e94560;color:#e94560;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px}
.trash-toggle:hover{background:#e94560;color:#fff}
.trash-toggle.active{background:#e94560;color:#fff}
.lib-overlay{display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.92);z-index:10001;overflow:auto}
.lib-panel{max-width:1200px;margin:20px auto;padding:20px;background:#1a1a2e;border-radius:12px;min-height:90vh}
.lib-header{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.lib-header h2{font-size:20px;color:#4fc3f7}
.lib-header .lib-close{margin-left:auto;background:#0f3460;color:#eee;border:none;padding:6px 16px;border-radius:4px;cursor:pointer;font-size:13px}
.lib-header .lib-close:hover{background:#e94560}
.lib-search{margin-bottom:16px}
.lib-search input{width:100%;padding:8px 14px;background:#0f3460;border:1px solid #1a3a6e;color:#eee;border-radius:6px;font-size:14px}
.lib-dims{margin-bottom:20px}
.lib-dim-section{margin-bottom:12px}
.lib-dim-label{font-size:12px;color:#4fc3f7;font-weight:bold;margin-bottom:4px;text-transform:uppercase}
.lib-dim-label.priority{color:#e94560;font-size:13px}
.lib-tags{display:flex;flex-wrap:wrap;gap:4px}
.lib-tag{background:#16213e;color:#ccc;border:1px solid #0f3460;padding:3px 10px;border-radius:14px;font-size:11px;cursor:pointer;transition:all .15s;white-space:nowrap}
.lib-tag:hover{background:#0f3460;color:#fff;border-color:#4fc3f7}
.lib-tag.active{background:#e94560;color:#fff;border-color:#e94560}
.lib-tag .tag-count{color:#888;font-size:10px;margin-left:2px}
.lib-tag.active .tag-count{color:#fdd}
.lib-results-header{font-size:13px;color:#aaa;margin:12px 0 8px;display:flex;align-items:center;gap:8px}
.lib-results-header .active-filters{display:flex;gap:4px;flex-wrap:wrap}
.lib-results-header .filter-chip{background:#e94560;color:#fff;padding:2px 8px;border-radius:10px;font-size:10px;cursor:pointer}
.lib-results-header .filter-chip:hover{background:#c0392b}
.lib-results{columns:240px;column-gap:10px}
.lib-card{break-inside:avoid;margin-bottom:10px;background:#16213e;border-radius:8px;overflow:hidden;border:1px solid #0f3460}
.lib-card img{width:100%;height:auto;display:block;cursor:pointer}
.lib-card .lib-card-info{padding:8px}
.lib-card .lib-card-prompt{font-size:11px;color:#8bc34a;line-height:1.4;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.lib-card .lib-card-desc{font-size:10px;color:#aaa;margin-top:4px;line-height:1.3}
.lib-card .lib-card-dims{display:flex;flex-wrap:wrap;gap:3px;margin-top:4px}
.lib-card .lib-card-dim-tag{background:#0f3460;color:#ccc;padding:1px 6px;border-radius:8px;font-size:9px}
</style>
</head>
<body>
<div class="sidebar" id="sidebar">
<h2>Characters (0)</h2>
<div class="search-box"><input id="searchInput" placeholder="Search..." oninput="filterList()"></div>
<div class="cat-filter" id="catFilter"></div>
<div class="toolbar"><button onclick="doRebuild()">Refresh</button><button onclick="openLibrary()" style="background:#4fc3f7;color:#000;font-weight:bold">素材库</button></div>
<div id="charList"></div>
</div>
<div class="main">
<div class="header" id="header"><h1>Select a character</h1><div class="desc"></div><div class="attrs"></div><div class="stats"></div></div>
<div id="profileSection"></div>
<div id="videoSection"></div>
<div id="generatedSection"></div>
<div id="refSection"></div>
<div id="trashSection"></div>
</div>
<div class="modal" id="modal"><button class="modal-close" id="modalClose">Close</button><button class="modal-del" id="modalDel">Delete</button><div class="modal-content" id="modalContent"></div></div>
<div class="lib-overlay" id="libOverlay" onclick="if(event.target===this)closeLibrary()">
<div class="lib-panel">
<div class="lib-header"><h2>素材库</h2><span id="libTotal" style="font-size:12px;color:#aaa"></span><button class="lib-close" onclick="closeLibrary()">✕ 关闭</button></div>
<div class="lib-search"><input id="libSearchInput" placeholder="搜索标签 (中英文)..." oninput="filterLibTags()"></div>
<div class="lib-dims" id="libDims"></div>
<div class="lib-results-header" id="libResultsHeader"></div>
<div class="lib-results" id="libResults"><div class="empty">点击标签筛选素材</div></div>
</div>
</div>
<script>
let idx={};let activeName=null;let activeCat=null;let showTrash=false;

async function load(){
    let r=await fetch('/api/index');idx=await r.json();
    renderCategories();
    renderSidebar();
}

function renderCategories(){
    let cats={};
    for(let n in idx){let c=idx[n].category;cats[c]=(cats[c]||0)+1;}
    let el=document.getElementById('catFilter');el.innerHTML='';
    let all=document.createElement('button');all.className='cat-btn'+(activeCat===null?' active':'');
    all.textContent='All';all.onclick=()=>{activeCat=null;renderSidebar();highlightCat();};
    el.appendChild(all);
    for(let[cat,cnt]of Object.entries(cats).sort((a,b)=>b[1]-a[1])){
        let b=document.createElement('button');b.className='cat-btn'+(activeCat===cat?' active':'');
        b.textContent=cat+' ('+cnt+')';
        b.onclick=()=>{activeCat=cat;renderSidebar();highlightCat();};
        el.appendChild(b);
    }
}
function highlightCat(){document.querySelectorAll('.cat-btn').forEach(b=>b.classList.remove('active'));
    for(let b of document.querySelectorAll('.cat-btn')){if((activeCat===null&&b.textContent==='All')||b.textContent.startsWith(activeCat))b.classList.add('active');}}

function filterList(){renderSidebar();}

function renderSidebar(){
    let q=(document.getElementById('searchInput').value||'').toLowerCase();
    let names=Object.keys(idx).filter(n=>{
        if(activeCat&&idx[n].category!==activeCat)return false;
        if(q&&!n.toLowerCase().includes(q))return false;
        return true;
    }).sort();
    document.querySelector('#sidebar h2').textContent='Characters ('+names.length+')';
    let list=document.getElementById('charList');list.innerHTML='';
    for(let n of names){
        let c=idx[n];
        let d=document.createElement('div');d.className='char-item';
        d.onclick=()=>selectChar(n);
        let thumb=c.profile_images[0]||'';
        let total=c.all_images.length;
        let vcount=c.profile_videos?c.profile_videos.length:0;
        let trashCount=c.trash_all?c.trash_all.length:0;
        let age=c.attributes&&c.attributes.Age?c.attributes.Age+' | ':'';
        let trashBadge=trashCount>0?' | '+trashCount+' in trash':'';
        d.innerHTML='<img class="char-thumb" src="'+thumb+'" onerror="this.style.display=\'none\'">'
            +'<div class="char-meta"><div class="char-name"></div><div class="char-info">'+age+c.category+' | '+total+' imgs, '+vcount+' vids'+trashBadge+'</div></div>';
        d.querySelector('.char-name').textContent=n;
        list.appendChild(d);
    }
}

function selectChar(name){
    activeName=name;
    document.querySelectorAll('.char-item').forEach(el=>el.classList.remove('active'));
    for(let el of document.querySelectorAll('.char-item')){
        if(el.querySelector('.char-name').textContent===name)el.classList.add('active');
    }
    let c=idx[name];
    document.querySelector('#header h1').textContent=name;
    document.querySelector('.desc').textContent=c.description;
    let attrs='';
    for(let[k,v]of Object.entries(c.attributes||{})){if(v)attrs+='<span class="attr-tag">'+k+': '+v+'</span>'}
    document.querySelector('.attrs').innerHTML=attrs;
    let trashCount=c.trash_all?c.trash_all.length:0;
    document.querySelector('.stats').textContent=c.profile_images.length+' imgs + '+c.profile_videos.length+' videos + '+c.generated_images.length+' generated'+(trashCount>0?' | '+trashCount+' in trash':'');

    let ps=document.getElementById('profileSection');
    ps.innerHTML='<div class="section-title">Profile Images</div><div class="grid" id="profileGrid"></div>';
    renderGrid('profileGrid',c.profile_images,'profile',false);

    let vs=document.getElementById('videoSection');
    vs.innerHTML='<div class="section-title">Videos ('+c.profile_videos.length+')</div><div class="grid" id="videoGrid"></div>';
    renderVideoGrid('videoGrid',c.profile_videos,false);

    let gs=document.getElementById('generatedSection');
    gs.innerHTML='<div class="section-title">Generated Images ('+c.generated_images.length+')</div><div class="grid" id="genGrid"></div>';
    renderGrid('genGrid',c.generated_images,'generated',false);

    renderRefSection();
    renderTrashSection();
}

function renderTrashSection(){
    let c=idx[activeName];
    let ts=document.getElementById('trashSection');
    let trashCount=c.trash_all?c.trash_all.length:0;
    let toggleText=showTrash?'Hide Trash':'Show Trash';
    let toggleClass='trash-toggle'+(showTrash?' active':'');
    ts.innerHTML='<div class="section-title">'
        +'<span>Trash ('+trashCount+')</span>'
        +'<div class="trash-actions">'
        +'<button class="'+toggleClass+'" onclick="toggleTrash()">'+toggleText+'</button>'
        +(trashCount>0?'<button class="btn-sm red" onclick="emptyTrash()">Empty Trash</button>':'')
        +'</div></div>'
        +'<div class="grid" id="trashGrid"></div>';
    if(showTrash&&trashCount>0){
        renderTrashGrid('trashGrid',c.trash_all);
    } else if(showTrash){
        document.getElementById('trashGrid').innerHTML='<div class="empty">Trash is empty</div>';
    }
}

function toggleTrash(){
    showTrash=!showTrash;
    renderTrashSection();
}

function renderTrashGrid(containerId,items){
    let g=document.getElementById(containerId);
    g.innerHTML='';
    for(let url of items){
        let fname=url.split('/').pop().split('?')[0];
        let isVideo=fname.match(/\.(mp4|webm|mov|avi)$/i);
        let card=document.createElement('div');card.className='card trashed';
        let badge=document.createElement('div');badge.className='badge';badge.textContent='trashed';
        let restoreBtn=document.createElement('button');restoreBtn.className='del-btn';restoreBtn.textContent='+';restoreBtn.title='Restore';
        restoreBtn.addEventListener('click',function(e){e.stopPropagation();doRestore(activeName,url)});
        if(isVideo){
            let vid=document.createElement('video');vid.src=url;vid.muted=true;vid.preload='metadata';
            vid.addEventListener('mouseenter',function(){this.play()});
            vid.addEventListener('mouseleave',function(){this.pause();this.currentTime=0});
            vid.addEventListener('click',function(){openModal(url)});
            card.appendChild(badge);card.appendChild(restoreBtn);card.appendChild(vid);
        } else {
            let imgEl=document.createElement('img');imgEl.src=url;imgEl.loading='lazy';
            imgEl.addEventListener('click',function(){openModal(url)});
            imgEl.onerror=function(){this.src='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect fill="%2316213e" width="180" height="180"/><text fill="%23666" x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="12">Load Failed</text></svg>';};
            card.appendChild(badge);card.appendChild(restoreBtn);card.appendChild(imgEl);
        }
        let nameEl=document.createElement('div');nameEl.className='img-name';nameEl.textContent=fname;
        card.appendChild(nameEl);
        g.appendChild(card);
    }
}

let refImages=[];
let vfeSearchResults=[];
const VFE_BASE='http://localhost:3001';

async function renderRefSection(){
    let c=idx[activeName];
    let sec=document.getElementById('refSection');
    sec.innerHTML='<div class="section-title">Reference Library</div>'
        +'<div class="ref-panel">'
        +'<div class="ref-search">'
        +'<input id="refSearchInput" placeholder="Search VFE by tag (e.g. bedroom, sitting)..." onkeydown="if(event.key===\'Enter\')searchVFE()">'
        +'<button onclick="searchVFE()">Search VFE</button>'
        +'</div>'
        +'<div id="refSearchResults" class="ref-results"></div>'
        +'</div>'
        +'<div id="refList"></div>';
    await loadRefImages();
}

async function loadRefImages(){
    let c=idx[activeName];
    try{
        let r=await fetch('/api/ref-images?character_id='+c.id);
        let d=await r.json();
        refImages=d.items||[];
    }catch(e){refImages=[];}
    renderRefList();
}

function renderRefList(){
    let el=document.getElementById('refList');
    if(!refImages.length){el.innerHTML='<div class="empty">No reference images linked. Search VFE above to add.</div>';return;}
    let html='<div style="font-size:13px;color:#aaa;margin:8px 0">'+refImages.length+' reference images</div><div class="ref-results">';
    for(let ref of refImages){
        let imgUrl=ref.image_url||'';
        let fname=imgUrl.split('/').pop().split('?')[0];
        let prompt=ref.prompt||'';
        html+='<div class="ref-card">'
            +'<button class="ref_remove" onclick="removeRef('+ref.id+')" title="Remove">X</button>'
            +'<img src="'+imgUrl+'" loading="lazy" onclick="openModal(\''+imgUrl.replace(/'/g,"\\'")+'\')">'
            +'<div class="ref_info"><div>'+fname+'</div>'
            +(prompt?'<div class="ref_prompt">'+prompt+'</div>':'')
            +'</div></div>';
    }
    html+='</div>';
    el.innerHTML=html;
}

async function searchVFE(){
    let q=document.getElementById('refSearchInput').value.trim();
    let url='/api/vfe/search?limit=50';
    if(q)url+='&tag='+encodeURIComponent(q);
    let el=document.getElementById('refSearchResults');
    el.innerHTML='<div class="empty">Searching VFE...</div>';
    try{
        let r=await fetch(url);
        let d=await r.json();
        vfeSearchResults=d.items||[];
        if(!vfeSearchResults.length){el.innerHTML='<div class="empty">No results from VFE'+(d.error?' ('+d.error+')':'')+'</div>';return;}
        let c=idx[activeName];
        let existingUrls=new Set(refImages.map(r=>r.image_url));
        let html='<div style="font-size:12px;color:#aaa;margin-bottom:6px">VFE results: '+d.total+' (click + to add)</div>';
        for(let item of vfeSearchResults){
            let fullUrl=VFE_BASE+item.image_url;
            let isAdded=existingUrls.has(fullUrl);
            let fname=(item.video_name||'').split('/').pop();
            let prompt=item.prompt||'';
            if(isAdded){
                html+='<div class="ref-card" style="opacity:0.5"><img src="'+fullUrl+'" loading="lazy" onclick="openModal(\''+fullUrl.replace(/'/g,"\\'")+'\')">'
                    +'<div class="ref_info"><div>'+fname+' (added)</div></div></div>';
            } else {
                let escapedUrl=fullUrl.replace(/'/g,"\\'").replace(/"/g,'&quot;');
                let escapedPrompt=(item.prompt||'').replace(/'/g,"\\'").replace(/"/g,'&quot;');
                let dims=JSON.stringify(item.dimensions||{}).replace(/'/g,"\\'").replace(/"/g,'&quot;');
                let tags=JSON.stringify(item.tags||[]).replace(/'/g,"\\'").replace(/"/g,'&quot;');
                html+='<div class="ref-card">'
                    +'<button class="ref_add" onclick="addRef(\''+escapedUrl+'\',\''+escapedPrompt+'\',\''+dims+'\',\''+tags+'\',\''+(item.style||'').replace(/'/g,"\\'")+'\',\''+(item.description||'').replace(/'/g,"\\'")+'\')" title="Add to character">+</button>'
                    +'<img src="'+fullUrl+'" loading="lazy" onclick="openModal(\''+escapedUrl+'\')">'
                    +'<div class="ref_info"><div>'+fname+'</div>'
                    +(prompt?'<div class="ref_prompt">'+prompt+'</div>':'')
                    +'</div></div>';
            }
        }
        el.innerHTML=html;
    }catch(e){
        el.innerHTML='<div class="empty">VFE connection failed. Is video-frame-extractor running on port 3001?</div>';
    }
}

async function addRef(imageUrl,prompt,dims,tags,style,description){
    let c=idx[activeName];
    try{
        let r=await fetch('/api/ref-images',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                character_id:c.id,
                image_url:imageUrl,
                prompt:prompt,
                dimensions:JSON.parse(dims.replace(/&quot;/g,'"')),
                tags:JSON.parse(tags.replace(/&quot;/g,'"')),
                style:style,
                description:description
            })
        });
        let d=await r.json();
        if(d.status==='ok'){
            await loadRefImages();
            searchVFE();
        }
    }catch(e){alert('Failed to add: '+e.message);}
}

async function removeRef(refId){
    if(!confirm('Remove this reference image?'))return;
    try{
        await fetch('/api/ref-images/delete',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({id:refId})
        });
        await loadRefImages();
    }catch(e){alert('Failed: '+e.message);}
}

function renderGrid(containerId,images,tag){
    let g=document.getElementById(containerId);
    if(!images.length){g.innerHTML='<div class="empty">No images</div>';return;}
    g.innerHTML='';
    for(let img of images){
        let fname=img.split('/').pop().split('?')[0];
        let card=document.createElement('div');card.className='card';
        let badge=document.createElement('div');badge.className='badge';badge.textContent=tag;
        let btn=document.createElement('button');btn.className='del-btn';btn.textContent='X';
        btn.addEventListener('click',function(e){e.stopPropagation();doDelete(activeName,img)});
        let imgEl=document.createElement('img');imgEl.src=img;imgEl.loading='lazy';
        imgEl.addEventListener('click',function(){openModal(img)});
        imgEl.onerror=function(){this.src='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect fill="%2316213e" width="180" height="180"><text fill="%23666" x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="12">Load Failed</text></svg>';};
        let nameEl=document.createElement('div');nameEl.className='img-name';nameEl.textContent=fname;
        card.appendChild(badge);card.appendChild(btn);card.appendChild(imgEl);card.appendChild(nameEl);
        g.appendChild(card);
    }
}
        card.appendChild(imgEl);card.appendChild(nameEl);
        g.appendChild(card);
    }
}

function renderVideoGrid(containerId,videos,isTrash){
    let g=document.getElementById(containerId);
    if(!videos.length){g.innerHTML='<div class="empty">No videos</div>';return;}
    g.innerHTML='';
    for(let url of videos){
        let fname=url.split('/').pop().split('?')[0];
        let card=document.createElement('div');card.className='card';
        let badge=document.createElement('div');badge.className='badge';badge.textContent='video';
        let btn=document.createElement('button');btn.className='del-btn';btn.textContent='X';
        btn.addEventListener('click',function(e){e.stopPropagation();doDelete(activeName,url)});
        let vid=document.createElement('video');vid.src=url;vid.muted=true;vid.preload='metadata';vid.style.minHeight='120px';vid.style.background='#0d1117';
        vid.addEventListener('mouseenter',function(){this.play()});
        vid.addEventListener('mouseleave',function(){this.pause();this.currentTime=0});
        vid.addEventListener('click',function(){openModal(url)});
        vid.onerror=function(){this.outerHTML='<div style="width:100%;min-height:120px;display:flex;align-items:center;justify-content:center;background:#16213e;color:#666;font-size:11px">Load Failed</div>';};
        let nameEl=document.createElement('div');nameEl.className='img-name';nameEl.textContent=fname;
        card.appendChild(badge);card.appendChild(btn);card.appendChild(vid);card.appendChild(nameEl);
        g.appendChild(card);
    }
}

function openModal(url){
    let isVideo=url.match(/\.(mp4|webm|mov|avi)(\?|$)/i);
    let content=document.getElementById('modalContent');
    content.innerHTML='';
    if(isVideo){
        let vid=document.createElement('video');vid.src=url;vid.controls=true;vid.autoplay=true;
        content.appendChild(vid);
    } else {
        let img=document.createElement('img');img.src=url;
        content.appendChild(img);
    }
    document.getElementById('modal').style.display='block';
    document.getElementById('modalDel').onclick=function(e){e.stopPropagation();doDelete(activeName,url);};
    document.getElementById('modalClose').onclick=function(e){e.stopPropagation();closeModal();};
    document.getElementById('modal').onclick=function(e){if(e.target===document.getElementById('modal'))closeModal();};
}

function closeModal(){
    let content=document.getElementById('modalContent');
    let vid=content.querySelector('video');
    if(vid)vid.pause();
    content.innerHTML='';
    document.getElementById('modal').style.display='none';
}

async function doDelete(name,imgUrl){
    if(!confirm('Move to trash?'))return;
    await fetch('/api/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,image_url:imgUrl})});
    let c=idx[name];
    c.profile_images=c.profile_images.filter(i=>i!==imgUrl);
    c.profile_videos=c.profile_videos.filter(i=>i!==imgUrl);
    c.generated_images=c.generated_images.filter(i=>i!==imgUrl);
    c.all_images=c.all_images.filter(i=>i!==imgUrl);
    if(!c.trash_all)c.trash_all=[];
    if(!c.trash_all.includes(imgUrl))c.trash_all.push(imgUrl);
    closeModal();
    selectChar(name);
    renderSidebar();
}

async function doRestore(name,imgUrl){
    await fetch('/api/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,image_url:imgUrl})});
    let c=idx[name];
    c.trash_all=(c.trash_all||[]).filter(i=>i!==imgUrl);
    c.trash_images=(c.trash_images||[]).filter(i=>i!==imgUrl);
    c.trash_videos=(c.trash_videos||[]).filter(i=>i!==imgUrl);
    c.trash_generated=(c.trash_generated||[]).filter(i=>i!==imgUrl);
    await doRebuildSilent();
    selectChar(name);
    renderSidebar();
}

async function emptyTrash(){
    if(!confirm('Permanently delete all items in trash?'))return;
    await fetch('/api/trash/empty',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:activeName})});
    let c=idx[activeName];
    c.trash_all=[];c.trash_images=[];c.trash_videos=[];c.trash_generated=[];
    selectChar(activeName);
    renderSidebar();
}

async function doRebuild(){
    let r=await fetch('/api/rebuild');let d=await r.json();
    await load();
    if(activeName)selectChar(activeName);
    alert('Refreshed: '+d.count+' characters');
}

async function doRebuildSilent(){
    let r=await fetch('/api/rebuild');
    await load();
}

let libTagCloud=null;
let libActiveFilters=[];
const DIM_LABELS={
    '01_scene':'场景','02_shot':'镜头','03_nudity':'裸露','04_clothing':'服装',
    '05_lighting':'光影','06_pose':'姿势','07_expression':'表情','08_style':'风格',
    '09_makeup':'妆容','10_hair':'发型','11_skin':'皮肤','12_tattoo':'纹身',
    '13_props':'道具','14_persona':'人设'
};
const DIM_PRIORITY=['01_scene','06_pose','04_clothing'];

async function openLibrary(){
    document.getElementById('libOverlay').style.display='block';
    if(!libTagCloud){
        document.getElementById('libDims').innerHTML='<div class="empty">加载中...</div>';
        try{
            let r=await fetch('/api/asset-library/tags');
            libTagCloud=await r.json();
        }catch(e){
            document.getElementById('libDims').innerHTML='<div class="empty">VFE 连接失败</div>';
            return;
        }
    }
    document.getElementById('libTotal').textContent=(libTagCloud.total_images||0)+' 张已标注素材';
    renderLibDims();
}

function closeLibrary(){
    document.getElementById('libOverlay').style.display='none';
}

function renderLibDims(){
    let dims=libTagCloud.dimensions||{};
    let el=document.getElementById('libDims');
    let html='';
    let priorityDims=DIM_PRIORITY.filter(d=>dims[d]);
    let otherDims=Object.keys(dims).filter(d=>!DIM_PRIORITY.includes(d)).sort();

    if(priorityDims.length){
        html+='<div class="lib-dim-section"><div class="lib-dim-label priority">★ 高优先</div><div class="lib-tags">';
        for(let dim of priorityDims){
            html+=renderDimGroup(dim,dims[dim]);
        }
        html+='</div></div>';
    }

    if(otherDims.length){
        html+='<div class="lib-dim-section"><div class="lib-dim-label">其他维度</div><div class="lib-tags">';
        for(let dim of otherDims){
            html+=renderDimGroup(dim,dims[dim]);
        }
        html+='</div></div>';
    }
    el.innerHTML=html;
}

function renderDimGroup(dim,tags){
    let label=DIM_LABELS[dim]||dim;
    let html='<span style="font-size:10px;color:#666;margin-right:2px">'+label+':</span>';
    let maxShow=8;
    for(let i=0;i<Math.min(tags.length,maxShow);i++){
        let t=tags[i];
        let isActive=libActiveFilters.some(f=>f.tag===t.tag);
        html+='<span class="lib-tag'+(isActive?' active':'')+'" onclick="toggleLibFilter(\''+dim+'\',\''+t.tag.replace(/'/g,"\\'")+'\')">'+t.tag+'<span class="tag-count">'+t.count+'</span></span>';
    }
    if(tags.length>maxShow){
        html+='<span style="font-size:10px;color:#666">+'+( tags.length-maxShow)+'</span>';
    }
    return html;
}

function toggleLibFilter(dim,tag){
    let idx=libActiveFilters.findIndex(f=>f.tag===tag);
    if(idx>=0){
        libActiveFilters.splice(idx,1);
    } else {
        libActiveFilters.push({dim,tag});
    }
    renderLibDims();
    renderLibFilters();
    if(libActiveFilters.length>0){
        loadLibImages();
    } else {
        document.getElementById('libResults').innerHTML='<div class="empty">点击标签筛选素材</div>';
        document.getElementById('libResultsHeader').innerHTML='';
    }
}

function renderLibFilters(){
    let el=document.getElementById('libResultsHeader');
    if(!libActiveFilters.length){el.innerHTML='';return;}
    let html='<span>筛选:</span><div class="active-filters">';
    for(let f of libActiveFilters){
        html+='<span class="filter-chip" onclick="toggleLibFilter(\''+f.dim+'\',\''+f.tag.replace(/'/g,"\\'")+'\')">'+f.tag+' ✕</span>';
    }
    html+='</div>';
    el.innerHTML=html;
}

async function loadLibImages(){
    let el=document.getElementById('libResults');
    el.innerHTML='<div class="empty">搜索中...</div>';
    let f=libActiveFilters[0];
    let url='/api/asset-library/images?limit=50';
    if(f){
        url+='&dimension='+encodeURIComponent(f.dim)+'&tag='+encodeURIComponent(f.tag);
    }
    try{
        let r=await fetch(url);
        let d=await r.json();
        renderLibResults(d);
    }catch(e){
        el.innerHTML='<div class="empty">加载失败: '+e.message+'</div>';
    }
}

function renderLibResults(data){
    let el=document.getElementById('libResults');
    let items=data.items||[];
    if(!items.length){el.innerHTML='<div class="empty">无匹配素材</div>';return;}
    let html='<div style="font-size:12px;color:#aaa;margin-bottom:8px">'+data.total+' 张匹配</div>';
    for(let item of items){
        let imgUrl=VFE_BASE+item.image_url;
        let prompt=item.prompt||'';
        let desc=item.description||'';
        let dims=item.dimensions||{};
        let dimTags='';
        for(let[dim,tags]of Object.entries(dims)){
            if(!Array.isArray(tags))continue;
            for(let t of tags.slice(0,2)){
                dimTags+='<span class="lib-card-dim-tag">'+t+'</span>';
            }
        }
        html+='<div class="lib-card">'
            +'<img src="'+imgUrl+'" loading="lazy" onclick="openModal(\''+imgUrl.replace(/'/g,"\\'")+'\')">'
            +'<div class="lib-card-info">'
            +(prompt?'<div class="lib-card-prompt">'+prompt+'</div>':'')
            +(desc?'<div class="lib-card-desc">'+desc+'</div>':'')
            +'<div class="lib-card-dims">'+dimTags+'</div>'
            +'</div></div>';
    }
    el.innerHTML=html;
}

function filterLibTags(){
    if(!libTagCloud)return;
    let q=document.getElementById('libSearchInput').value.trim().toLowerCase();
    if(!q){renderLibDims();return;}
    let dims=libTagCloud.dimensions||{};
    let filtered={};
    for(let[dim,tags]of Object.entries(dims)){
        let matched=tags.filter(t=>t.tag.toLowerCase().includes(q));
        if(matched.length)filtered[dim]=matched;
    }
    let el=document.getElementById('libDims');
    let html='';
    for(let[dim,tags]of Object.entries(filtered)){
        html+='<div class="lib-dim-section"><div class="lib-dim-label">'+(DIM_LABELS[dim]||dim)+'</div><div class="lib-tags">';
        for(let t of tags.slice(0,20)){
            let isActive=libActiveFilters.some(f=>f.tag===t.tag);
            html+='<span class="lib-tag'+(isActive?' active':'')+'" onclick="toggleLibFilter(\''+dim+'\',\''+t.tag.replace(/'/g,"\\'")+'\')">'+t.tag+'<span class="tag-count">'+t.count+'</span></span>';
        }
        html+='</div></div>';
    }
    if(!html)html='<div class="empty">无匹配标签</div>';
    el.innerHTML=html;
}

load();
</script>
</body>
</html>"""


def main():
    global pool
    pool = psycopg2.pool.ThreadedConnectionPool(2, 10, DATABASE_URL)
    idx = rebuild_index()

    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log(f"Character Manager running at http://0.0.0.0:{PORT}")
    log(f"Characters: {len(idx)}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    server.server_close()
    pool.closeall()


if __name__ == "__main__":
    main()
