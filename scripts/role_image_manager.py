import http.server
import json
import os
import shutil
import threading
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote
from datetime import datetime
from copy import deepcopy

CHARACTER_JSON = r"C:\project\tool\output\character_swapface.json"
BACKUP_DIR = r"C:\project\tool\output\character_swapface_backup"
PROGRESS_JSON = r"C:\project\tool\output\swaceface_progress.json"
PORT = 9090
LOG_FILE = r"C:\project\tool\output\swapface_manager.log"

lock = threading.Lock()

with open(CHARACTER_JSON, encoding="utf-8") as f:
    character_data = json.load(f)
with open(PROGRESS_JSON, encoding="utf-8") as f:
    progress_data = json.load(f)


def log(msg):
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"[{datetime.now().isoformat()}] {msg}\n")
    print(msg)


def backup_once(filepath):
    os.makedirs(BACKUP_DIR, exist_ok=True)
    backup_path = os.path.join(BACKUP_DIR, "original_" + Path(filepath).name)
    if not os.path.exists(backup_path):
        shutil.copy2(filepath, backup_path)
        log(f"首次备份 {filepath} -> {backup_path}")


def load_index():
    face_to_results = {}
    for task in progress_data["tasks"]:
        if task["status"] == "completed" and task.get("result_files"):
            face_key = task["face_image"]
            if face_key not in face_to_results:
                face_to_results[face_key] = []
            for rf in task["result_files"]:
                if os.path.exists(rf) and rf not in face_to_results[face_key]:
                    face_to_results[face_key].append(rf)

    name_to_face = {}
    for category, characters in character_data.items():
        for char in characters:
            name = char.get("name", "")
            for media in char.get("media", []):
                if media.get("type") == "image":
                    name_to_face[name] = media["url"]

    index = {}
    for face_path, results in face_to_results.items():
        face_stem = Path(face_path).stem
        matched_name = None
        matched_info = None
        matched_category = None
        for name, fp in name_to_face.items():
            if fp == face_path:
                matched_name = name
                for category, characters in character_data.items():
                    for char in characters:
                        if char.get("name") == name:
                            matched_info = char
                            matched_category = category
                            break
                break

        if matched_name and matched_info:
            index[matched_name] = {
                "category": matched_category,
                "face_stem": face_stem,
                "description": matched_info.get("description", ""),
                "attributes": matched_info.get("attributes", {}),
                "swapface_images": results,
            }
        else:
            index[face_stem] = {
                "category": "unmatched",
                "face_stem": face_stem,
                "description": "",
                "attributes": {},
                "swapface_images": results,
            }

    return index


def save_character_json():
    with lock:
        with open(CHARACTER_JSON, "w", encoding="utf-8") as f:
            json.dump(character_data, f, indent=2, ensure_ascii=False)
    log(f"已保存 {CHARACTER_JSON}")


class ThreadedHTTPServer(http.server.ThreadingHTTPServer):
    pass


class Handler(http.server.BaseHTTPRequestHandler):
    index = None

    def do_GET(self):
        if self.path == "/" or self.path == "/index.html":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(PAGE.encode("utf-8"))
        elif self.path == "/api/index":
            if Handler.index is None:
                Handler.index = load_index()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(Handler.index, ensure_ascii=False).encode("utf-8"))
        elif self.path.startswith("/api/image"):
            qs = parse_qs(urlparse(self.path).query)
            img_path = unquote(qs.get("path", [""])[0])
            if img_path and os.path.exists(img_path):
                ext = Path(img_path).suffix.lower()
                mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}.get(ext.lstrip("."), "image/png")
                self.send_response(200)
                self.send_header("Content-Type", mime)
                self.end_headers()
                with open(img_path, "rb") as f:
                    self.wfile.write(f.read())
            else:
                self.send_response(404)
                self.end_headers()
        elif self.path == "/api/rebuild":
            Handler.index = load_index()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "count": len(Handler.index)}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8")
        data = json.loads(body)

        if self.path == "/api/delete":
            name = data.get("name", "")
            img_path = data.get("image_path", "")
            log(f"[DELETE] name={name}, img={img_path}")

            if name in Handler.index:
                swapface = Handler.index[name]["swapface_images"]
                if img_path in swapface:
                    swapface.remove(img_path)
                category = Handler.index[name]["category"]
                if category != "unmatched":
                    for char in character_data[category]:
                        if char.get("name") == name:
                            char["swapface_images"] = [i for i in char.get("swapface_images", []) if i != img_path]
                            break
                threading.Thread(target=save_character_json, daemon=True).start()

            remaining = len(Handler.index.get(name, {}).get("swapface_images", []))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "remaining": remaining}).encode("utf-8"))

        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        log(format % args)


PAGE = """<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>Swapface Manager</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#1a1a2e;color:#eee}
.sidebar{width:260px;height:100vh;overflow-y:auto;position:fixed;left:0;top:0;background:#16213e;border-right:1px solid #0f3460}
.sidebar h2{padding:12px 16px;background:#0f3460;font-size:14px}
.char-item{padding:10px 16px;cursor:pointer;border-bottom:1px solid #0f3460;transition:background .15s}
.char-item:hover{background:#0f3460}
.char-item.active{background:#e94560}
.char-name{font-size:14px;font-weight:bold}
.char-info{font-size:11px;color:#aaa;margin-top:2px}
.main{margin-left:260px;padding:20px}
.header{margin-bottom:20px}
.header h1{font-size:24px}
.header .desc{font-size:13px;color:#aaa;margin-top:6px}
.header .attrs{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.attr-tag{background:#0f3460;padding:3px 10px;border-radius:12px;font-size:11px}
.grid{display:flex;gap:16px;flex-wrap:wrap}
.card{position:relative;width:200px;background:#16213e;border-radius:8px;overflow:hidden;border:1px solid #0f3460}
.card img{width:200px;height:200px;object-fit:cover;display:block;cursor:pointer}
.card .del-btn{position:absolute;top:4px;right:4px;background:#e94560;color:#fff;border:none;width:24px;height:24px;border-radius:50%;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s}
.card:hover .del-btn{opacity:1}
.card .img-name{padding:6px 8px;font-size:11px;color:#aaa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stats{font-size:13px;color:#aaa;margin-top:4px}
.empty{color:#666;font-size:14px;padding:40px 0}
.modal{display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.85);z-index:9999}
.modal img{max-width:90vw;max-height:90vh;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)}
.modal .modal-del{position:absolute;top:20px;right:20px;background:#e94560;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;z-index:10000}
.modal .modal-close{position:absolute;top:20px;left:20px;background:#0f3460;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;z-index:10000}
</style>
</head>
<body>
<div class="sidebar" id="sidebar"><h2>Characters (0)</h2><div id="charList"></div></div>
<div class="main">
<div class="header" id="header"><h1>Select a character</h1><div class="desc"></div><div class="attrs"></div><div class="stats"></div></div>
<div class="grid" id="grid"></div>
<div class="modal" id="modal"><button class="modal-close" id="modalClose">Close</button><button class="modal-del" id="modalDel">Delete</button><img id="modalImg"></div>
<script>
let idx={};let activeName=null;

async function load(){
    let r=await fetch('/api/index');idx=await r.json();
    renderSidebar();
}

function renderSidebar(){
    let names=Object.keys(idx).sort((a,b)=>(idx[a].face_stem||'').localeCompare(idx[b].face_stem||''));
    document.querySelector('#sidebar h2').textContent='Characters ('+names.length+')';
    let list=document.getElementById('charList');list.innerHTML='';
    for(let n of names){
        let c=idx[n];let d=document.createElement('div');d.className='char-item';
        d.onclick=()=>selectChar(n);
        d.innerHTML='<div class="char-name">'+n+'</div><div class="char-info">'+(c.attributes.Age||'')+' | '+c.swapface_images.length+' imgs</div>';
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
    for(let[k,v]of Object.entries(c.attributes)){if(v)attrs+='<span class="attr-tag">'+k+': '+v+'</span>'}
    document.querySelector('.attrs').innerHTML=attrs;
    document.querySelector('.stats').textContent=c.swapface_images.length+' swapface images';
    renderGrid(c.swapface_images);
}

function renderGrid(images){
    let g=document.getElementById('grid');
    if(!images.length){g.innerHTML='<div class="empty">No images</div>';return;}
    g.innerHTML='';
    for(let i=0;i<images.length;i++){
        let img=images[i];let fname=img.split(/[\\/]/).pop();
        let card=document.createElement('div');card.className='card';
        let btn=document.createElement('button');btn.className='del-btn';btn.textContent='X';
        btn.addEventListener('click',function(e){e.stopPropagation();doDelete(activeName,img)});
        let imgEl=document.createElement('img');
        imgEl.src='/api/image?path='+encodeURIComponent(img);
        imgEl.addEventListener('click',function(){openModal(img)});
        let nameEl=document.createElement('div');nameEl.className='img-name';nameEl.textContent=fname;
        card.appendChild(btn);card.appendChild(imgEl);card.appendChild(nameEl);
        g.appendChild(card);
    }
}

function openModal(imgPath){
    document.getElementById('modalImg').src='/api/image?path='+encodeURIComponent(imgPath);
    document.getElementById('modal').style.display='block';
    document.getElementById('modalDel').onclick=function(e){e.stopPropagation();doDelete(activeName,imgPath);};
    document.getElementById('modalClose').onclick=function(e){e.stopPropagation();document.getElementById('modal').style.display='none';};
    document.getElementById('modal').onclick=function(e){if(e.target===document.getElementById('modal'))e.target.style.display='none';};
}

async function doDelete(name,imgPath){
    if(!confirm('Remove this image from JSON?'))return;
    let r=await fetch('/api/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,image_path:imgPath})});
    let d=await r.json();
    idx[name].swapface_images=idx[name].swapface_images.filter(i=>i!==imgPath);
    document.getElementById('modal').style.display='none';
    document.querySelector('.stats').textContent=idx[name].swapface_images.length+' swapface images';
    renderGrid(idx[name].swapface_images);
}

load();
</script>
</body>
</html>"""


def main():
    Handler.index = load_index()
    backup_once(CHARACTER_JSON)
    backup_once(PROGRESS_JSON)
    server = ThreadedHTTPServer(("localhost", PORT), Handler)
    print(f"Swapface Manager running at http://localhost:{PORT}")
    print(f"Characters: {len(Handler.index)}")
    print("Press Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    server.server_close()


if __name__ == "__main__":
    main()