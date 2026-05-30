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

            profile_images = [m["url"] for m in media_list if m.get("type") == "image" and m.get("url")]
            profile_videos = [m["url"] for m in media_list if m.get("type") == "video" and m.get("url")]
            swapface_images = [m["url"] for m in media_list if m.get("type") == "swapface_image" and m.get("url")]

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

        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        data = self._read_body()
        path = urlparse(self.path).path

        if path == "/api/delete":
            name = data.get("name", "")
            img_url = data.get("image_url", "")
            log(f"[DELETE] name={name}, url={img_url}")

            conn = get_conn()
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT id, media FROM characters WHERE name = %s", (name,))
                    row = cur.fetchone()
                    if row:
                        cid, media_raw = row
                        media_list = _parse_json(media_raw) or []
                        new_media = [m for m in media_list if m.get("url") != img_url]
                        cur.execute("UPDATE characters SET media = %s::json WHERE id = %s",
                                    (json.dumps(new_media), cid))

                    cur.execute("DELETE FROM media_generation_tasks WHERE character_name = %s AND result_url = %s",
                                (name, img_url))
                    cur.execute("DELETE FROM user_character_media WHERE media_url = %s", (img_url,))
                conn.commit()
            finally:
                put_conn(conn)

            idx = get_cached_index()
            if name in idx:
                idx["profile_images"] = [u for u in idx["profile_images"] if u != img_url]
                idx["generated_images"] = [u for u in idx["generated_images"] if u != img_url]
                idx["all_images"] = [u for u in idx["all_images"] if u != img_url]

            remaining = len(idx.get(name, {}).get("all_images", []))
            self._json_response({"status": "ok", "remaining": remaining})

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
.section-title{font-size:14px;color:#aaa;margin:16px 0 8px;border-bottom:1px solid #0f3460;padding-bottom:4px}
.grid{display:flex;gap:12px;flex-wrap:wrap}
.card{position:relative;width:180px;background:#16213e;border-radius:8px;overflow:hidden;border:1px solid #0f3460}
.card img{width:180px;height:180px;object-fit:cover;display:block;cursor:pointer}
.card .del-btn{position:absolute;top:4px;right:4px;background:rgba(233,69,96,0.85);color:#fff;border:none;width:22px;height:22px;border-radius:50%;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s}
.card:hover .del-btn{opacity:1}
.card .badge{position:absolute;top:4px;left:4px;background:rgba(15,52,96,0.85);color:#eee;padding:2px 6px;border-radius:3px;font-size:10px}
.card .img-name{padding:4px 6px;font-size:10px;color:#aaa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stats{font-size:13px;color:#aaa;margin-top:4px}
.empty{color:#666;font-size:14px;padding:40px 0}
.modal{display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.9);z-index:9999}
.modal img{max-width:90vw;max-height:90vh;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)}
.modal .modal-del{position:absolute;top:20px;right:20px;background:#e94560;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;z-index:10000}
.modal .modal-close{position:absolute;top:20px;left:20px;background:#0f3460;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;z-index:10000}
.toolbar{padding:8px 12px;display:flex;gap:6px}
.toolbar button{background:#0f3460;color:#eee;border:none;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px}
.toolbar button:hover{background:#e94560}
</style>
</head>
<body>
<div class="sidebar" id="sidebar">
<h2>Characters (0)</h2>
<div class="search-box"><input id="searchInput" placeholder="Search..." oninput="filterList()"></div>
<div class="cat-filter" id="catFilter"></div>
<div class="toolbar"><button onclick="doRebuild()">Refresh</button></div>
<div id="charList"></div>
</div>
<div class="main">
<div class="header" id="header"><h1>Select a character</h1><div class="desc"></div><div class="attrs"></div><div class="stats"></div></div>
<div id="profileSection"></div>
<div id="generatedSection"></div>
</div>
<div class="modal" id="modal"><button class="modal-close" id="modalClose">Close</button><button class="modal-del" id="modalDel">Delete</button><img id="modalImg"></div>
<script>
let idx={};let activeName=null;let activeCat=null;

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
        let age=c.attributes&&c.attributes.Age?c.attributes.Age+' | ':'';
        d.innerHTML='<img class="char-thumb" src="'+thumb+'" onerror="this.style.display=\'none\'">'
            +'<div class="char-meta"><div class="char-name"></div><div class="char-info">'+age+c.category+' | '+total+' imgs</div></div>';
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
    document.querySelector('.stats').textContent=c.profile_images.length+' profile + '+c.generated_images.length+' generated';

    let ps=document.getElementById('profileSection');
    ps.innerHTML='<div class="section-title">Profile Images</div><div class="grid" id="profileGrid"></div>';
    renderGrid('profileGrid',c.profile_images,'profile');

    let gs=document.getElementById('generatedSection');
    gs.innerHTML='<div class="section-title">Generated Images</div><div class="grid" id="genGrid"></div>';
    renderGrid('genGrid',c.generated_images,'generated');
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
        imgEl.onerror=function(){this.src='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect fill="%2316213e" width="180" height="180"/><text fill="%23666" x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="12">Load Failed</text></svg>';};
        let nameEl=document.createElement('div');nameEl.className='img-name';nameEl.textContent=fname;
        card.appendChild(badge);card.appendChild(btn);card.appendChild(imgEl);card.appendChild(nameEl);
        g.appendChild(card);
    }
}

function openModal(imgUrl){
    document.getElementById('modalImg').src=imgUrl;
    document.getElementById('modal').style.display='block';
    document.getElementById('modalDel').onclick=function(e){e.stopPropagation();doDelete(activeName,imgUrl);};
    document.getElementById('modalClose').onclick=function(e){e.stopPropagation();document.getElementById('modal').style.display='none';};
    document.getElementById('modal').onclick=function(e){if(e.target===document.getElementById('modal'))e.target.style.display='none';};
}

async function doDelete(name,imgUrl){
    if(!confirm('Remove this image?'))return;
    let r=await fetch('/api/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,image_url:imgUrl})});
    let d=await r.json();
    idx[name].profile_images=idx[name].profile_images.filter(i=>i!==imgUrl);
    idx[name].generated_images=idx[name].generated_images.filter(i=>i!==imgUrl);
    idx[name].all_images=idx[name].all_images.filter(i=>i!==imgUrl);
    document.getElementById('modal').style.display='none';
    selectChar(name);
}

async function doRebuild(){
    let r=await fetch('/api/rebuild');let d=await r.json();
    await load();
    if(activeName)selectChar(activeName);
    alert('Refreshed: '+d.count+' characters');
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
