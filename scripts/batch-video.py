#!/usr/bin/env python3
"""
批量视频生成脚本 — LTX Video (Vantage-Sulphur-2)

读取 video_prompts_grok.jsonl (Grok 生成的视频提示词),
逐个调用 ComfyUI Vantage-Sulphur-2 工作流生成视频。

GPU → 端口映射 (4 × A100, 选每 GPU 第一个端口):
  GPU 0 → 8188
  GPU 1 → 8189
  GPU 2 → 8190
  GPU 3 → 8191

用法:
  python3 batch-video.py \
    --prompts-file video_prompts_grok.jsonl \
    --image-dir output-v2-20260527_004937 \
    --output-dir output-v2-20260527_004937-videos \
    --comfyui-shared-input /path/to/comfyui/input \
    --workflow Vantage-Sulphur-2-Workflow.json
"""

import json
import os
import random
import time
import sys
import fcntl
import argparse
import threading
import shutil
from pathlib import Path
from datetime import datetime, timezone

import requests

BASE = Path(__file__).parent

# GPU 0:8188, GPU 1:8189, GPU 2:8190, GPU 3:8191 (每GPU只用一个)
GPU_PORTS = [8188, 8189, 8190, 8191]

# ═══════════════════════════════════════════════════
# 提示词加载
# ═══════════════════════════════════════════════════

def load_prompts(prompts_file):
    """读取 JSONL, 返回 [(image_path, prompt), ...]"""
    items = []
    with open(prompts_file, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            data = json.loads(line)
            items.append((data['first_frame_path'], data['prompt']))
    return items


# ═══════════════════════════════════════════════════
# 进度管理
# ═══════════════════════════════════════════════════

class ProgressManager:
    STALE_TIMEOUT = 600  # 视频生成时间长, 10分钟超时

    def __init__(self, progress_path, items):
        self.path = Path(progress_path)
        self._lock = threading.Lock()
        self.items = items

    def _read(self):
        if not self.path.exists():
            return {"run_id": datetime.now().strftime("%Y%m%d_%H%M%S"), "items": {}}
        with open(self.path, 'r', encoding='utf-8') as f:
            try:
                return json.load(f)
            except (json.JSONDecodeError, ValueError):
                return {"run_id": datetime.now().strftime("%Y%m%d_%H%M%S"), "items": {}}

    def _write(self, data):
        tmp = self.path.with_suffix('.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.path)

    def _atomic_update(self, updater):
        with self._lock:
            f = open(self.path, 'a' if self.path.exists() else 'w')
            try:
                fcntl.flock(f, fcntl.LOCK_EX)
                data = self._read()
                updater(data)
                self._write(data)
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)
                f.close()

    def init_run(self, image_dir):
        def _init(data):
            for i, (img_path, prompt) in enumerate(self.items):
                key = img_path
                if key not in data['items']:
                    data['items'][key] = {
                        "index": i,
                        "image_path": img_path,
                        "prompt": prompt,
                        "status": "pending"
                    }
            data['image_dir'] = str(image_dir)
            data['total_items'] = len(data['items'])
        self._atomic_update(_init)

    def recover_stale(self):
        now = datetime.now(timezone.utc)
        def _recover(data):
            for key, info in data['items'].items():
                if info['status'] == 'processing':
                    updated_str = info.get('updated_at', info.get('started_at', ''))
                    if updated_str:
                        try:
                            updated = datetime.fromisoformat(updated_str)
                        except ValueError:
                            updated = datetime.min.replace(tzinfo=timezone.utc)
                        if updated.tzinfo is None:
                            updated = updated.replace(tzinfo=timezone.utc)
                        if (now - updated).total_seconds() > self.STALE_TIMEOUT:
                            print(f"  [recover] {key} 僵死 → pending")
                            info['status'] = 'pending'
                            info.pop('assigned_port', None)
                            info.pop('started_at', None)
        self._atomic_update(_recover)

    def claim_item(self, port):
        result = [None]
        def _claim(data):
            for key, info in data['items'].items():
                if info['status'] == 'pending':
                    info['status'] = 'processing'
                    info['assigned_port'] = port
                    now = datetime.now(timezone.utc).isoformat()
                    info['started_at'] = now
                    info['updated_at'] = now
                    result[0] = key
                    return
        self._atomic_update(_claim)
        return result[0]

    def heartbeat(self, key):
        def _hb(data):
            item = data['items'].get(key)
            if item:
                item['updated_at'] = datetime.now(timezone.utc).isoformat()
        self._atomic_update(_hb)

    def add_result(self, key, video_output, success):
        def _add(data):
            item = data['items'].get(key)
            if item:
                item['status'] = 'done' if success else 'failed'
                item['video_output'] = video_output
                item['completed_at'] = datetime.now(timezone.utc).isoformat()
        self._atomic_update(_add)

    def release_item(self, key):
        def _release(data):
            item = data['items'].get(key)
            if item and item['status'] == 'processing':
                item['status'] = 'pending'
                item.pop('assigned_port', None)
                item.pop('started_at', None)
        self._atomic_update(_release)

    def get_stats(self):
        data = self._read()
        total = len(data['items'])
        done = sum(1 for v in data['items'].values() if v['status'] == 'done')
        failed = sum(1 for v in data['items'].values() if v['status'] == 'failed')
        processing = sum(1 for v in data['items'].values() if v['status'] == 'processing')
        pending = sum(1 for v in data['items'].values() if v['status'] == 'pending')
        return total, done, failed, processing, pending


# ═══════════════════════════════════════════════════
# ComfyUI API
# ═══════════════════════════════════════════════════

class ComfyUIClient:
    def __init__(self, host, port):
        self.base = f"http://{host}:{port}"

    def check_health(self, timeout=10):
        try:
            r = requests.get(f"{self.base}/system_stats", timeout=timeout)
            return r.status_code == 200
        except Exception:
            return False

    def upload_image(self, image_path, filename, shared_input_dir=None):
        if shared_input_dir:
            shared = Path(shared_input_dir) / filename
            if not shared.exists():
                shutil.copy2(image_path, shared)
            return filename
        with open(image_path, 'rb') as f:
            r = requests.post(f"{self.base}/upload/image",
                              files={"image": (filename, f)}, timeout=30)
        r.raise_for_status()
        return filename

    def submit_workflow(self, workflow, timeout=30):
        r = requests.post(f"{self.base}/prompt",
                          json={"prompt": workflow}, timeout=timeout)
        r.raise_for_status()
        data = r.json()
        if 'prompt_id' not in data:
            raise RuntimeError(f"Unexpected response: {data}")
        return data['prompt_id']

    def get_history(self, prompt_id, timeout=30):
        r = requests.get(f"{self.base}/history/{prompt_id}", timeout=timeout)
        r.raise_for_status()
        return r.json().get(prompt_id)

    def interrupt(self):
        try:
            requests.post(f"{self.base}/interrupt", timeout=5)
        except Exception:
            pass


# ═══════════════════════════════════════════════════
# 工作流构建
# ═══════════════════════════════════════════════════

class WorkflowManager:
    # SaveVideo 节点的 class_type
    SAVE_VIDEO_CLASS = "SaveVideo"

    def __init__(self, workflow_path):
        with open(workflow_path, 'r', encoding='utf-8') as f:
            self.template = json.load(f)

    def build(self, image_filename, prompt, video_prefix, seed=None):
        wf = json.loads(json.dumps(self.template))

        # Node 255: LoadImage — 设置输入图片
        if '255' in wf:
            wf['255']['inputs']['image'] = image_filename

        # Node 393: PrimitiveStringMultiline — 设置 prompt
        if '393' in wf:
            wf['393']['inputs']['value'] = prompt

        # Node 259: RandomNoise — 设置 seed
        if seed is None:
            seed = random.randint(0, 2_147_483_647)
        if '259' in wf:
            wf['259']['inputs']['noise_seed'] = seed

        # Node 327: SaveVideo — 设置输出前缀
        if '327' in wf:
            wf['327']['inputs']['filename_prefix'] = video_prefix

        return wf, seed

    @staticmethod
    def get_output_prefix(history):
        """从 history 提取 SaveVideo 的输出前缀"""
        try:
            for node_id, node_output in history.get('outputs', {}).items():
                if 'gifs' in node_output:
                    for gif in node_output['gifs']:
                        return gif.get('filename', ''), gif.get('subfolder', '')
                if 'videos' in node_output:
                    for vid in node_output['videos']:
                        return vid.get('filename', ''), vid.get('subfolder', '')
        except Exception:
            pass
        return None, ''

    @staticmethod
    def get_output_video_files(history):
        """从 history 提取所有输出视频文件信息 (SaveVideo 存 mp4 在 images 字段)"""
        results = []
        try:
            for node_id, node_output in history.get('outputs', {}).items():
                for key in ('images', 'gifs', 'videos'):
                    for item in node_output.get(key, []):
                        fn = item.get('filename', '')
                        if fn:
                            results.append((
                                fn,
                                item.get('subfolder', ''),
                                item.get('type', 'output')
                            ))
        except Exception:
            pass
        return results

    @staticmethod
    def is_completed(history):
        """检查 history 是否已完成 (无论成功失败)"""
        try:
            status = history.get('status', {})
            return status.get('completed', False) is not False
        except Exception:
            return True  # 有 history 就算完成了


# ═══════════════════════════════════════════════════
# Worker
# ═══════════════════════════════════════════════════

class Worker(threading.Thread):
    MAX_RETRIES = 2
    POLL_INTERVAL = 10      # 视频生成慢, 10s 轮询
    MAX_WAIT = 1800          # 30 分钟超时

    def __init__(self, port, host, shared_input_dir, output_dir,
                 progress, workflow, image_dir):
        super().__init__(daemon=True)
        self.port = port
        self.client = ComfyUIClient(host, port)
        self.shared_input_dir = shared_input_dir
        self.output_dir = Path(output_dir)
        self.progress = progress
        self.workflow = workflow
        self.image_dir = Path(image_dir)
        self.running = True
        self.label = f"[{port}]"

    def log(self, msg):
        print(f"{self.label} {msg}", flush=True)

    def run(self):
        self.log("启动 (Vantage-Sulphur-2)")
        if not self.client.check_health():
            self.log("ComfyUI 不可达, 退出")
            return

        while self.running:
            key = self.progress.claim_item(self.port)
            if key is None:
                self.log("无待处理任务, 退出")
                break

            self.log(f"拿到: {key}")
            data = self.progress._read()
            item = data['items'].get(key, {})
            self._process_item(key, item.get('image_path', key), item.get('prompt', ''))

        self.log("结束")

    def _process_item(self, key, image_path, prompt):
        local_path = self.image_dir / image_path
        if not local_path.exists():
            self.log(f"图片不存在: {local_path}")
            self.progress.add_result(key, None, success=False)
            return

        # 上传图片到 ComfyUI shared input (用唯一文件名避免冲突)
        stem = Path(image_path).stem
        img_filename = f"{stem}_{Path(image_path).name}"
        try:
            self.client.upload_image(local_path, img_filename, self.shared_input_dir)
        except Exception as e:
            self.log(f"上传失败: {e}")
            self.progress.release_item(key)
            return

        # 输出前缀: 去掉扩展名做目录名
        stem = Path(image_path).stem
        video_prefix = f"v2videos/{stem}/{stem}"

        seed = random.randint(0, 2_147_483_647)
        wf, seed = self.workflow.build(img_filename, prompt, video_prefix, seed)

        for attempt in range(1, self.MAX_RETRIES + 1):
            try:
                prompt_id = self.client.submit_workflow(wf)
                self.log(f"  [{key}] id={prompt_id} seed={seed}")

                result = self._poll_until_done(prompt_id)
                if result is None:
                    raise RuntimeError("超时")

                # 下载视频文件
                saved_files = []
                for vid_fn, subfolder, img_type in result:
                    if vid_fn:
                        # 下载到本地
                        output_subdir = self.output_dir / stem
                        output_subdir.mkdir(parents=True, exist_ok=True)
                        local_vid_path = output_subdir / vid_fn
                        # 如果 ComfyUI output 目录可访问, 直接复制
                        # 否则用 API download (ComfyUI 没有直接的 video download API, 
                        # 但他们存在 output 目录下)
                        # 尝试从 ComfyUI output 目录复制
                        saved_files.append(str(local_vid_path.relative_to(self.output_dir)))

                video_output = saved_files[0] if saved_files else None
                self.progress.add_result(key, video_output, success=bool(saved_files))
                self.log(f"  [{key}] ✓ → {video_output}")
                return

            except Exception as e:
                self.log(f"  [{key}] 尝试{attempt}/{self.MAX_RETRIES} 失败: {e}")
                if attempt == self.MAX_RETRIES:
                    self.progress.add_result(key, None, success=False)
                    self.log(f"  [{key}] ✗ 最终失败")
                else:
                    time.sleep(30 * attempt)

    def _poll_until_done(self, prompt_id):
        start = time.time()
        while time.time() - start < self.MAX_WAIT:
            try:
                history = self.client.get_history(prompt_id)
                if history is not None:
                    if WorkflowManager.is_completed(history):
                        videos = WorkflowManager.get_output_video_files(history)
                        if videos:
                            return videos
                        # 完成了但是没找到视频 — 可能是报错
                        status_info = history.get('status', {})
                        messages = status_info.get('messages', [])
                        if messages:
                            raise RuntimeError(f"ComfyUI error: {messages[-1][:200]}")
                        raise RuntimeError("Completed but no video output found")
            except RuntimeError:
                raise
            except Exception:
                pass
            time.sleep(self.POLL_INTERVAL)
        return None

    def stop(self):
        self.running = False
        self.client.interrupt()


# ═══════════════════════════════════════════════════
# 视频文件提取 — 从 ComfyUI output 目录复制
# ═══════════════════════════════════════════════════

def copy_videos_from_comfyui_output(progress_path, output_dir, comfyui_output_dir):
    """从 ComfyUI output 目录复制生成的视频到本地 output_dir"""
    with open(progress_path, 'r', encoding='utf-8') as f:
        progress = json.load(f)

    comfyui_output = Path(comfyui_output_dir)
    output_dir = Path(output_dir)
    copied = 0

    for key, info in progress.get('items', {}).items():
        if info.get('status') != 'done':
            continue
        history = info.get('history')
        if not history:
            continue

        stem = Path(info['image_path']).stem
        dest_dir = output_dir / stem
        dest_dir.mkdir(parents=True, exist_ok=True)

        for node_id, node_output in history.get('outputs', {}).items():
            for media_key in ('gifs', 'videos', 'images'):
                for item in node_output.get(media_key, []):
                    fn = item.get('filename', '')
                    sub = item.get('subfolder', '')
                    if sub:
                        src = comfyui_output / sub / fn
                    else:
                        src = comfyui_output / fn
                    if src.exists():
                        dest = dest_dir / fn
                        if not dest.exists():
                            shutil.copy2(src, dest)
                            copied += 1

    return copied


# ═══════════════════════════════════════════════════
# 扫描 ComfyUI output 目录下载视频
# ═══════════════════════════════════════════════════

def copy_videos_from_comfyui(progress_file, output_dir, comfyui_output):
    """生成完成后, 从 ComfyUI output 目录复制视频到本地"""
    with open(progress_file, 'r', encoding='utf-8') as f:
        progress = json.load(f)

    comfyui_output = Path(comfyui_output)
    output_dir = Path(output_dir)
    copied = 0

    for key, info in progress.get('items', {}).items():
        if info.get('status') != 'done':
            continue
        stem = Path(info['image_path']).stem
        dest_dir = output_dir / stem

        # 扫描 ComfyUI output 目录下以 stem 开头的视频文件
        prefix = f"v2videos/{stem}/"
        search_dir = comfyui_output
        for part in prefix.split('/'):
            search_dir = search_dir / part

        if search_dir.exists():
            for f in search_dir.iterdir():
                if f.suffix.lower() in ('.mp4', '.webm', '.gif', '.avi', '.mov'):
                    dest = dest_dir / f.name
                    dest_dir.mkdir(parents=True, exist_ok=True)
                    if not dest.exists():
                        shutil.copy2(f, dest)
                        copied += 1

    return copied


# ═══════════════════════════════════════════════════
# 主控
# ═══════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description='批量视频生成 — Vantage-Sulphur-2')
    parser.add_argument('--prompts-file', type=str, required=True,
                        help='Grok 生成的 JSONL 提示词文件')
    parser.add_argument('--image-dir', type=str, required=True,
                        help='输入图片目录 (首帧)')
    parser.add_argument('--output-dir', type=str, default=None,
                        help='输出目录 (默认 image-dir 同级加 -videos 后缀)')
    parser.add_argument('--comfyui-shared-input', type=str, required=True,
                        help='ComfyUI 共享 input 目录')
    parser.add_argument('--comfyui-output', type=str, default=None,
                        help='ComfyUI output 目录 (完成后从这复制视频, 默认 /root/comfy/ComfyUI/output)')
    parser.add_argument('--workflow', type=str, required=True,
                        help='Vantage-Sulphur-2 工作流 JSON')
    parser.add_argument('--progress-file', type=str, default=None,
                        help='进度文件 (默认 output-dir/progress.json)')
    parser.add_argument('--ports', type=str, default='8188,8189,8190,8191',
                        help='ComfyUI 端口, 逗号分隔 (默认 GPU0:8188,GPU1:8189,GPU2:8190,GPU3:8191)')
    parser.add_argument('--host', type=str, default='127.0.0.1',
                        help='ComfyUI 主机地址')
    parser.add_argument('--max-items', type=int, default=None,
                        help='最多处理几条 (默认全部)')
    args = parser.parse_args()

    # 加载提示词
    print("── 加载提示词 ──")
    items = load_prompts(args.prompts_file)
    if args.max_items:
        items = items[:args.max_items]
    print(f"  共 {len(items)} 条")
    print()

    # 输出目录
    if args.output_dir:
        output_dir = Path(args.output_dir)
    else:
        output_dir = Path(args.image_dir).parent / (Path(args.image_dir).name + '-videos')
    output_dir.mkdir(parents=True, exist_ok=True)

    progress_file = args.progress_file or str(output_dir / 'progress.json')
    ports = [int(p.strip()) for p in args.ports.split(',') if p.strip()]
    comfyui_output_dir = args.comfyui_output or '/root/comfy/ComfyUI/output'

    # 检查 ComfyUI
    print("── 检查 ComfyUI ──")
    alive, dead = [], []
    for p in ports:
        c = ComfyUIClient(args.host, p)
        if c.check_health():
            alive.append(p)
            gpu_map = {8188:0, 8189:1, 8190:2, 8191:3, 8192:0, 8193:1, 8194:2, 8195:3}
            gpu = gpu_map.get(p, '?')
            print(f"  [{p}] ✓ GPU{gpu}")
        else:
            dead.append(p)
            print(f"  [{p}] ✗")
    if not alive:
        print("无存活实例, 退出")
        sys.exit(1)
    print()

    # 进度管理
    progress = ProgressManager(progress_file, items)
    progress.init_run(args.image_dir)
    progress.recover_stale()
    total, done, failed, processing, pending = progress.get_stats()
    print(f"── 进度 ──")
    print(f"  总计: {total} | 已完成: {done} | 失败: {failed} | 处理中: {processing} | 待处理: {pending}")
    if pending == 0:
        print("全部完成, 复制视频...")
        n = copy_videos_from_comfyui(progress_file, str(output_dir), comfyui_output_dir)
        print(f"复制了 {n} 个视频到 {output_dir}")
        return
    print()

    # 启动 workers
    workflow = WorkflowManager(args.workflow)
    print(f"── 启动 {len(alive)} 个 worker (LTX Video) ──")
    workers = []
    for port in alive:
        w = Worker(port=port, host=args.host,
                   shared_input_dir=args.comfyui_shared_input,
                   output_dir=output_dir, progress=progress,
                   workflow=workflow, image_dir=args.image_dir)
        w.start()
        workers.append(w)

    try:
        for w in workers:
            w.join()
    except KeyboardInterrupt:
        print("\n中断, 停止 workers...")
        for w in workers:
            w.stop()
        for w in workers:
            w.join(timeout=10)

    # 从 ComfyUI output 复制视频
    total, done, failed, processing, pending = progress.get_stats()
    print(f"\n── 复制视频 ──")
    print(f"  完成: {done}/{total} | 失败: {failed}")
    n = copy_videos_from_comfyui(progress_file, str(output_dir), comfyui_output_dir)
    print(f"  复制了 {n} 个视频到 {output_dir}")
    print(f"  进度文件: {progress_file}")


if __name__ == '__main__':
    main()