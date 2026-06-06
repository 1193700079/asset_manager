#!/usr/bin/env python3
"""
批量 FaceSwap 流水线 (DB版)
从数据库读取换脸任务 → ComfyUI 换脸 → 上传 OSS → 写回 DB

工作流:
1. 从 faceswap_tasks 表读取待处理任务 (face_image + body_image)
2. 并发调用 ComfyUI (8 端口) 执行换脸
3. 下载结果并上传到 OSS
4. 更新 DB 状态

目录模式:
    --face-dir: 人脸图片目录
    --body-dir: body 图片目录
    自动生成 face×body 任务写入 DB，然后处理

用法:
    # 从 DB 读取待处理任务
    python batch_faceswap_from_db.py

    # 从目录生成任务并写入 DB，然后处理
    python batch_faceswap_from_db.py --face-dir ./girls --body-dir ./selected

    # 限制数量
    python batch_faceswap_from_db.py --face-dir ./girls --body-dir ./selected --max-faces 5 --max-bodies 3

    # 干跑
    python batch_faceswap_from_db.py --dry-run

    # 只生成任务不入库不执行
    python batch_faceswap_from_db.py --face-dir ./girls --body-dir ./selected --gen-only
"""

import argparse
import asyncio
import copy
import json
import os
import random
import sys
import time
from datetime import datetime
from pathlib import Path

import aiohttp
import asyncpg
import oss2

# ============================================================
# OSS 配置
# ============================================================
OSS_CONFIG_FILE = "/mnt/user/joseph/data/ScrapedData/ecoss_config.json"
OSS_SUBFOLDER = "faceswap/"

_oss_bucket = None
_oss_config = None

def get_oss_bucket():
    global _oss_bucket, _oss_config
    if _oss_bucket is None:
        with open(OSS_CONFIG_FILE, "r") as f:
            _oss_config = json.load(f)
        auth = oss2.Auth(_oss_config["access_key_id"], _oss_config["access_key_secret"])
        _oss_bucket = oss2.Bucket(
            auth,
            _oss_config["endpoint"],
            _oss_config["bucket_name"],
            connect_timeout=30
        )
    return _oss_bucket

def get_oss_prefix():
    cfg = _oss_config
    return cfg.get("folder", "") + OSS_SUBFOLDER

def upload_to_oss(local_path: str, filename: str) -> str | None:
    """上传文件到OSS，返回完整URL"""
    bucket = get_oss_bucket()
    prefix = get_oss_prefix()
    oss_key = prefix + filename
    try:
        bucket.put_object_from_file(oss_key, local_path)
        endpoint = bucket.endpoint
        if not endpoint.startswith("http"):
            endpoint = "https://" + endpoint
        endpoint = endpoint.rstrip("/")
        host = endpoint.replace("http://", "").replace("https://", "")
        url = f"https://{bucket.bucket_name}.{host}/{oss_key}"
        return url
    except Exception as e:
        print(f"  ⚠ OSS upload failed for {filename}: {e}")
        return None

# ============================================================
# DB 配置
# ============================================================
DB_HOST = os.environ.get("DB_HOST", "127.0.0.1")
DB_PORT = os.environ.get("DB_PORT", "5432")
DB_USER = os.environ.get("DB_USER", "video_frames")
DB_PASS = os.environ.get("DB_PASS", "video_frames_pwd")
DB_NAME = os.environ.get("DB_NAME", "video_frames")

# 优先使用 Supabase Pooler URL（如果环境变量存在）
SUPABASE_URL = os.environ.get("SUPABASE_POOLER_URL", "")
if SUPABASE_URL:
    DB_DSN = SUPABASE_URL
    DB_IS_PGBOUNCER = True
else:
    DB_DSN = f"postgres://{DB_USER}:{DB_PASS}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
    DB_IS_PGBOUNCER = False

def _get_conn_kwargs():
    """Return extra kwargs for asyncpg.connect, handling pgbouncer"""
    if DB_IS_PGBOUNCER:
        return {"statement_cache_size": 0}
    return {}

# ============================================================
# 路径配置
# ============================================================
SCRAPE_DIR = Path("/mnt/user/joseph/data/ScrapedData")
WORKFLOW_PATH = SCRAPE_DIR / "换脸生视频工作流.json"
FACE_DIR = SCRAPE_DIR / "virtual-gf-pose-library" / "girls"
BODY_DIR = SCRAPE_DIR / "image_picker" / "selected"
OUTPUT_DIR = SCRAPE_DIR / "faceswap_output"
OUTPUT_DIR_TMP = Path("/tmp/faceswap_output")  # ComfyUI 结果先下载到这里
COMFYUI_OUTPUT_DIR = Path("/mnt/cypher/project/ComfyUI/output")

# ============================================================
# ComfyUI 配置
# ============================================================
HOST = "localhost"
PORTS = list(range(8188, 8196))
CONCURRENCY = len(PORTS)

# 工作流节点 ID
NODE_BODY_IMAGE = "39"    # LoadImage: Reference Body
NODE_FACE_IMAGE = "40"    # LoadImage: Reference Face
NODE_NOISE_SEED = "23"    # RandomNoise
NODE_SAVE_IMAGE = "32"    # SaveImage

TIMEOUT = 600
POLL_INTERVAL = 3
POLL_TIMEOUT = 900
MAX_RETRIES = 2
SEED_MAX = 2**31 - 1

SUPPORTED_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

# ============================================================
# DB: 建表
# ============================================================

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS faceswap_tasks (
    id SERIAL PRIMARY KEY,
    face_image TEXT NOT NULL,
    body_image TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    seed INTEGER,
    prompt_id TEXT,
    output_oss_url TEXT,
    output_local_path TEXT,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP,
    context TEXT
);
"""

async def ensure_table():
    """确保 faceswap_tasks 表存在"""
    conn = await asyncpg.connect(DB_DSN, **_get_conn_kwargs())
    try:
        await conn.execute(CREATE_TABLE_SQL)
        print("✅ faceswap_tasks 表已就绪")
    finally:
        await conn.close()

# ============================================================
# DB: 任务读写
# ============================================================

async def insert_tasks_db(tasks: list[dict]) -> int:
    """批量插入任务，返回插入数量"""
    if not tasks:
        return 0
    conn = await asyncpg.connect(DB_DSN, **_get_conn_kwargs())
    try:
        await conn.executemany(
            """INSERT INTO faceswap_tasks (face_image, body_image, seed, context)
               VALUES ($1, $2, $3, $4)""",
            [(t["face_image"], t["body_image"], t.get("seed", 0), t.get("context", ""))
             for t in tasks]
        )
        return len(tasks)
    finally:
        await conn.close()

async def fetch_pending_tasks(limit: int | None = None) -> list[dict]:
    """从 DB 拉取 status='pending' 的任务"""
    conn = await asyncpg.connect(DB_DSN, **_get_conn_kwargs())
    try:
        if limit:
            rows = await conn.fetch(
                "SELECT * FROM faceswap_tasks WHERE status='pending' ORDER BY id LIMIT $1",
                limit
            )
        else:
            rows = await conn.fetch(
                "SELECT * FROM faceswap_tasks WHERE status='pending' ORDER BY id"
            )
        return [dict(r) for r in rows]
    finally:
        await conn.close()

async def update_task_status(task_id: int, status: str, **kwargs):
    """更新单个任务状态"""
    conn = await asyncpg.connect(DB_DSN, **_get_conn_kwargs())
    try:
        sets = ["status = $1"]
        params = [status]
        idx = 2
        for k, v in kwargs.items():
            if v is not None:
                sets.append(f"{k} = ${idx}")
                params.append(v)
                idx += 1
        if status == "completed" or status == "failed":
            sets.append(f"completed_at = NOW()")
        params.append(task_id)
        await conn.execute(
            f"UPDATE faceswap_tasks SET {', '.join(sets)} WHERE id = ${idx}",
            *params
        )
    finally:
        await conn.close()

# ============================================================
# 任务生成
# ============================================================

def build_tasks_from_dirs(face_dir: str, body_dir: str, max_faces: int | None, max_bodies: int | None) -> list[dict]:
    """
    扫描 face_dir 和 body_dir，生成 face×body 配对任务。
    每张 body 图配一张随机 face，保证均匀分布。
    """
    face_path = Path(face_dir)
    body_path = Path(body_dir)

    if not face_path.is_dir():
        print(f"❌ 人脸目录不存在: {face_dir}")
        sys.exit(1)
    if not body_path.is_dir():
        print(f"❌ body 目录不存在: {body_dir}")
        sys.exit(1)

    face_files = sorted([
        f for f in face_path.iterdir()
        if f.suffix.lower() in SUPPORTED_EXT
    ])
    body_files = sorted([
        f for f in body_path.iterdir()
        if f.suffix.lower() in SUPPORTED_EXT
    ])

    if max_faces:
        face_files = face_files[:max_faces]
    if max_bodies:
        body_files = body_files[:max_bodies]

    if not face_files:
        print(f"❌ 人脸目录没有图片: {face_dir}")
        sys.exit(1)
    if not body_files:
        print(f"❌ body 目录没有图片: {body_dir}")
        sys.exit(1)

    print(f"📸 人脸: {len(face_files)} 张, Body: {len(body_files)} 张")

    # 每张 body 配一张随机 face，循环使用
    tasks = []
    context = f"batch_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    for i, body in enumerate(body_files):
        face = face_files[i % len(face_files)]
        tasks.append({
            "face_image": str(face.resolve()),
            "body_image": str(body.resolve()),
            "seed": random.randint(0, SEED_MAX),
            "context": context,
        })

    print(f"📋 生成 {len(tasks)} 个换脸任务")
    return tasks

# ============================================================
# ComfyUI 交互
# ============================================================

async def upload_image_comfy(session: aiohttp.ClientSession, port: int, image_path: str) -> str | None:
    """上传图片到 ComfyUI，返回服务器端文件名"""
    url = f"http://{HOST}:{port}/upload/image"
    filename = os.path.basename(image_path)
    try:
        data = aiohttp.FormData()
        data.add_field("image", open(image_path, "rb"), filename=filename)
        async with session.post(url, data=data, timeout=aiohttp.ClientTimeout(total=30)) as resp:
            if resp.status == 200:
                result = await resp.json()
                return result["name"]
            else:
                text = await resp.text()
                print(f"  ⚠ upload failed port={port}: {text[:100]}")
                return None
    except Exception as e:
        print(f"  ⚠ upload error port={port}: {e}")
        return None

async def submit_workflow(session: aiohttp.ClientSession, port: int, workflow: dict) -> tuple[str, str] | tuple[None, str]:
    """提交工作流，返回 (prompt_id, None) 或 (None, error)"""
    url = f"http://{HOST}:{port}/prompt"
    try:
        async with session.post(url, json={"prompt": workflow}, timeout=aiohttp.ClientTimeout(total=30)) as resp:
            data = await resp.json()
            if "prompt_id" in data:
                return (data["prompt_id"], None)
            elif "error" in data:
                return (None, str(data["error"]))
            else:
                text = await resp.text()
                return (None, f"unexpected: {text[:200]}")
    except Exception as e:
        return (None, f"connection error: {e}")

async def poll_result(session: aiohttp.ClientSession, port: int, prompt_id: str) -> dict | None:
    """轮询直到完成，返回 history entry"""
    url = f"http://{HOST}:{port}/history/{prompt_id}"
    elapsed = 0
    while elapsed < POLL_TIMEOUT:
        try:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    if prompt_id in data:
                        entry = data[prompt_id]
                        status = entry.get("status", {})
                        if status.get("completed", False) or "outputs" in entry:
                            return entry
        except Exception:
            pass
        await asyncio.sleep(POLL_INTERVAL)
        elapsed += POLL_INTERVAL
    return None

def extract_filenames(history: dict) -> list[str]:
    """从 history 提取输出文件名列表"""
    filenames = []
    for node_id, node_output in history.get("outputs", {}).items():
        for img in node_output.get("images", []):
            fname = img.get("filename", "")
            subfolder = img.get("subfolder", "")
            if subfolder:
                filenames.append(f"{subfolder}/{fname}")
            else:
                filenames.append(fname)
    return filenames

def load_workflow_template() -> dict:
    with open(WORKFLOW_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def patch_workflow(template: dict, body_filename: str, face_filename: str, seed: int) -> dict:
    """修改工作流模板：替换 body/face 图片名 + seed"""
    wf = copy.deepcopy(template)
    wf[NODE_BODY_IMAGE]["inputs"]["image"] = body_filename
    wf[NODE_FACE_IMAGE]["inputs"]["image"] = face_filename
    wf[NODE_NOISE_SEED]["inputs"]["noise_seed"] = seed
    return wf

# ============================================================
# 单次换脸
# ============================================================

async def run_one_swap(
    session: aiohttp.ClientSession,
    port: int,
    port_idx: int,
    workflow: dict,
    body_path: str,
    face_path: str,
    seed: int,
    task_id: int,
    retries: int = MAX_RETRIES,
) -> dict:
    """
    执行一次换脸：
    1. 上传 body + face 到 ComfyUI
    2. 提交工作流
    3. 轮询结果
    4. 下载结果到本地
    返回 {"status": "completed"/"failed", "output_files": [...], "error": "..."}
    """
    current_port = port
    current_idx = port_idx

    # Step 1: 上传图片
    body_filename = await upload_image_comfy(session, current_port, body_path)
    if not body_filename:
        return {"status": "failed", "error": "body upload failed"}

    face_filename = await upload_image_comfy(session, current_port, face_path)
    if not face_filename:
        return {"status": "failed", "error": "face upload failed"}

    # Step 2: patch workflow
    wf = patch_workflow(workflow, body_filename, face_filename, seed)

    for attempt in range(retries + 1):
        # Step 3: 提交
        prompt_id, err = await submit_workflow(session, current_port, wf)
        if err:
            print(f"    [submit fail] port={current_port} attempt={attempt+1}: {err}")
            current_idx = (current_idx + 1) % len(PORTS)
            current_port = PORTS[current_idx]
            continue

        # Step 4: 轮询
        history = await poll_result(session, current_port, prompt_id)
        if history is None:
            print(f"    [poll timeout] port={current_port} prompt_id={prompt_id[:8]}...")
            current_idx = (current_idx + 1) % len(PORTS)
            current_port = PORTS[current_idx]
            continue

        status = history.get("status", {})
        if status.get("status_str") == "error":
            err_msg = str(status.get("messages", "unknown error"))
            return {"status": "failed", "prompt_id": prompt_id, "error": err_msg}

        output_files = extract_filenames(history)
        if not output_files:
            return {"status": "failed", "prompt_id": prompt_id, "error": "no output files"}

        return {"status": "completed", "prompt_id": prompt_id, "output_files": output_files}

    return {"status": "failed", "error": "exhausted retries"}

# ============================================================
# Worker
# ============================================================

async def worker(
    worker_id: int,
    port: int,
    port_idx: int,
    queue: asyncio.Queue,
    template: dict,
    dry_run: bool = False,
):
    """单个 worker：从队列取任务，执行换脸 + OSS 上传 + DB 更新"""
    stagger = random.uniform(0.5, 3.0)
    await asyncio.sleep(stagger)

    async with aiohttp.ClientSession() as session:
        while True:
            try:
                task = queue.get_nowait()
            except asyncio.QueueEmpty:
                break

            task_id = task["id"]
            face_path = task["face_image"]
            body_path = task["body_image"]
            seed = task.get("seed", random.randint(0, SEED_MAX))

            face_name = os.path.basename(face_path)
            body_name = os.path.basename(body_path)

            print(f"\n[worker {worker_id} | port {port}] task_id={task_id}")
            print(f"  🧑 Face: {face_name}")
            print(f"  🧍 Body: {body_name}")

            if dry_run:
                print(f"  🧪 DRY RUN — 跳过")
                await update_task_status(task_id, "skipped")
                queue.task_done()
                continue

            # 更新状态为 running
            await update_task_status(task_id, "running")

            # 执行换脸
            result = await run_one_swap(
                session, port, port_idx, template,
                body_path, face_path, seed, task_id
            )

            if result["status"] != "completed":
                err = result.get("error", "unknown")
                print(f"  ❌ 失败: {err}")
                await update_task_status(task_id, "failed", error_message=err)
                queue.task_done()
                continue

            output_files = result["output_files"]
            prompt_id = result["prompt_id"]
            print(f"  ✅ 换脸完成: {output_files}")

            # 下载结果到本地临时目录
            output_dir_tmp = OUTPUT_DIR_TMP / str(task_id)
            output_dir_tmp.mkdir(parents=True, exist_ok=True)

            local_paths = []
            for rel_path in output_files:
                src = COMFYUI_OUTPUT_DIR / rel_path
                dst = output_dir_tmp / os.path.basename(rel_path)
                if src.exists():
                    dst.write_bytes(src.read_bytes())
                    local_paths.append(str(dst))
                    print(f"  📥 下载: {os.path.basename(rel_path)} ({dst.stat().st_size // 1024}KB)")
                else:
                    print(f"  ⚠ 文件不存在: {src}")

            if not local_paths:
                await update_task_status(task_id, "failed", error_message="no local files downloaded")
                queue.task_done()
                continue

            # 上传到 OSS
            oss_urls = []
            for lp in local_paths:
                oss_url = await asyncio.to_thread(
                    upload_to_oss, lp, f"task_{task_id}/{os.path.basename(lp)}"
                )
                if oss_url:
                    oss_urls.append(oss_url)
                    print(f"  📤 OSS: {oss_url}")

            first_oss = oss_urls[0] if oss_urls else ""
            first_local = local_paths[0] if local_paths else ""

            # 更新 DB
            await update_task_status(
                task_id, "completed",
                seed=seed,
                prompt_id=prompt_id,
                output_oss_url=first_oss,
                output_local_path=first_local,
            )

            # 复制到永久输出目录
            perm_dir = OUTPUT_DIR / str(task_id)
            perm_dir.mkdir(parents=True, exist_ok=True)
            for lp in local_paths:
                dst = perm_dir / os.path.basename(lp)
                dst.write_bytes(Path(lp).read_bytes())
            print(f"  💾 永久保存: {perm_dir}")

            queue.task_done()

# ============================================================
# 主流程
# ============================================================

async def main():
    parser = argparse.ArgumentParser(description="批量 FaceSwap (DB + OSS)")
    parser.add_argument("--face-dir", type=str, help="人脸图片目录")
    parser.add_argument("--body-dir", type=str, help="body 图片目录")
    parser.add_argument("--max-faces", type=int, default=None, help="最多使用几张人脸")
    parser.add_argument("--max-bodies", type=int, default=None, help="最多使用几张 body")
    parser.add_argument("--gen-only", action="store_true", help="只生成任务写入 DB，不执行")
    parser.add_argument("--dry-run", action="store_true", help="只打印任务，不调 ComfyUI")
    parser.add_argument("--limit", type=int, default=None, help="最多处理几个任务 (DB模式)")
    parser.add_argument("--workers", type=int, default=CONCURRENCY, help=f"并发数 (默认 {CONCURRENCY})")
    args = parser.parse_args()

    # 确保表存在
    await ensure_table()

    tasks = []

    if args.face_dir and args.body_dir:
        # ── 目录模式：生成任务 ──
        print("=" * 60)
        print("  FaceSwap Batch — 目录模式")
        print("=" * 60)
        generated = build_tasks_from_dirs(
            args.face_dir, args.body_dir,
            args.max_faces, args.max_bodies
        )

        if args.gen_only:
            count = await insert_tasks_db(generated)
            print(f"✅ 已写入 {count} 个任务到 faceswap_tasks 表")
            print("   使用 --limit 参数来执行这些任务")
            return

        # 先写入 DB，再读取回来（带 ID）
        count = await insert_tasks_db(generated)
        print(f"✅ 已写入 {count} 个任务到 DB，开始执行...")
        tasks = await fetch_pending_tasks(args.limit)

    else:
        # ── DB 模式：读取已有任务 ──
        print("=" * 60)
        print("  FaceSwap Batch — DB 模式")
        print("=" * 60)
        tasks = await fetch_pending_tasks(args.limit)

    if not tasks:
        print("✅ 没有待处理的任务")
        return

    print(f"📊 待处理任务: {len(tasks)}")
    if args.dry_run:
        print("🧪 DRY RUN 模式")
        for t in tasks:
            print(f"  [{t['id']}] face={os.path.basename(t['face_image'])} body={os.path.basename(t['body_image'])}")
        return

    # 加载工作流模板
    if not WORKFLOW_PATH.exists():
        print(f"❌ 工作流模板不存在: {WORKFLOW_PATH}")
        sys.exit(1)
    template = load_workflow_template()
    print(f"✅ 工作流模板加载: {len(template)} 节点")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # 构建任务队列
    queue: asyncio.Queue = asyncio.Queue()
    for t in tasks:
        await queue.put(t)

    # 启动 worker
    workers = []
    ports = PORTS[:args.workers]
    for i, port in enumerate(ports):
        w = asyncio.create_task(worker(
            worker_id=i,
            port=port,
            port_idx=i,
            queue=queue,
            template=template,
            dry_run=args.dry_run,
        ))
        workers.append(w)

    start_ts = time.time()
    await asyncio.gather(*workers)
    elapsed = time.time() - start_ts

    # 汇总
    conn = await asyncpg.connect(DB_DSN, **_get_conn_kwargs())
    try:
        stats = await conn.fetchrow("""
            SELECT
                COUNT(*) FILTER (WHERE status='completed') AS ok,
                COUNT(*) FILTER (WHERE status='failed') AS fail,
                COUNT(*) FILTER (WHERE status='pending') AS pending
            FROM faceswap_tasks
            WHERE context = $1
        """, tasks[0].get("context", ""))
    finally:
        await conn.close()

    print("\n" + "=" * 60)
    print(f"🎉 全部完成! 耗时 {elapsed:.0f}s")
    print(f"  ✅ 成功: {stats['ok'] if stats else '?'}")
    print(f"  ❌ 失败: {stats['fail'] if stats else '?'}")
    print(f"  ⏳ 待处理: {stats['pending'] if stats else '?'}")
    print(f"  📁 输出: {OUTPUT_DIR}")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())