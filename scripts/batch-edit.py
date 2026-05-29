#!/usr/bin/env python3
"""
批量图片编辑脚本 — 角色版本

读取角色 JSON + girls/ 目录图片, 为每个角色生成编辑图,
追加到角色的 media 数组, 输出完整角色 JSON。

用法:
  python3 batch-edit.py \
    --character-json character_swapface_oss_with_videos_uploaded.json \
    --input-dir girls \
    --output-dir /path/to/output \
    --output-json /path/to/output_characters.json \
    --comfyui-shared-input /path/to/comfyui/input \
    --workflow workflow.json \
    --prompts-per-image 10 \
    --ports 8188,8189,8190,8191,8192,8193,8194,8195
"""

import json
import random
import time
import os
import sys
import fcntl
import argparse
import threading
import shutil
from pathlib import Path
from datetime import datetime, timezone

import requests

# ── 路径 ──────────────────────────────────────────
BASE = Path(__file__).parent


# ═══════════════════════════════════════════════════
# Prompt 生成
# ═══════════════════════════════════════════════════

class PromptGenerator:
    def __init__(self):
        with open(BASE / 'scenes.json', 'r', encoding='utf-8') as f:
            self.scenes = json.load(f)
        with open(BASE / 'captions_merged.json', 'r', encoding='utf-8') as f:
            self.clothes = json.load(f)
        with open(BASE / 'poses.json', 'r', encoding='utf-8') as f:
            self.poses = json.load(f)['poses']
        self._lock = threading.Lock()

    def generate(self, category=None, tag=None):
        poses = self.poses
        if category:
            poses = [p for p in poses if p['category'] == category]
        if tag:
            poses = [p for p in poses if any(tag in t for t in p['tags'])]
        if not poses:
            poses = self.poses
        with self._lock:
            scene = random.choice(self.scenes)
            cloth = random.choice(self.clothes)
            pose = random.choice(poses)
        return f"{scene}，{cloth}，{pose['pose']}。"

    def generate_batch(self, n, category=None, tag=None):
        return [self.generate(category, tag) for _ in range(n)]


# ═══════════════════════════════════════════════════
# 角色 JSON 加载 & 映射
# ═══════════════════════════════════════════════════

def load_character_map(character_json_path, input_dir):
    """
    读取角色 JSON, 建立 图片文件名 → (角色索引, 角色对象) 的映射。
    只包含 input_dir 中实际存在的图片。
    """
    with open(character_json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    characters = data.get('ai-girlfriend', data.get('characters', []))
    input_dir = Path(input_dir)
    existing = {f.name for f in input_dir.glob('*') if f.suffix.lower()
                in {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff'}}

    image_to_char = {}   # image_filename -> (char_index, char)
    unmatched = []       # characters without matching image

    for idx, char in enumerate(characters):
        image_found = None
        for m in char.get('media', []):
            if m.get('type') == 'image':
                url = m.get('url', '')
                fn = Path(url).name.replace('\\', '/').split('/')[-1]
                if fn in existing:
                    image_found = fn
                    break
        if image_found:
            image_to_char[image_found] = (idx, char)
        else:
            unmatched.append((idx, char['name']))

    return data, characters, image_to_char, unmatched


# ═══════════════════════════════════════════════════
# 进度管理 — 基于角色 JSON
# ═══════════════════════════════════════════════════

class ProgressManager:
    STALE_TIMEOUT = 300

    def __init__(self, progress_path, image_to_char):
        self.path = Path(progress_path)
        self._lock = threading.Lock()
        self.image_to_char = image_to_char  # image_filename -> (char_idx, char)
        self.characters = None             # set by init

    def _read(self):
        if not self.path.exists():
            return {"run_id": datetime.now().strftime("%Y%m%d_%H%M%S"), "images": {}}
        with open(self.path, 'r', encoding='utf-8') as f:
            try:
                return json.load(f)
            except (json.JSONDecodeError, ValueError):
                return {"run_id": datetime.now().strftime("%Y%m%d_%H%M%S"), "images": {}}

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

    def init_run(self, input_dir):
        """初始化: 只登记有角色映射的图片"""
        input_dir = Path(input_dir)
        def _init(data):
            for fn in self.image_to_char:
                if fn not in data['images']:
                    data['images'][fn] = {"status": "pending", "results": []}
            data['input_dir'] = str(input_dir)
            data['total_images'] = len(data['images'])
        self._atomic_update(_init)

    def recover_stale(self):
        now = datetime.now(timezone.utc)
        def _recover(data):
            for name, info in data['images'].items():
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
                            print(f"  [recover] {name} 僵死 → pending")
                            info['status'] = 'pending'
                            info.pop('assigned_port', None)
                            info.pop('started_at', None)
        self._atomic_update(_recover)

    def claim_image(self, port):
        result = [None]
        def _claim(data):
            for name, info in data['images'].items():
                if info['status'] == 'pending':
                    info['status'] = 'processing'
                    info['assigned_port'] = port
                    now = datetime.now(timezone.utc).isoformat()
                    info['started_at'] = now
                    info['updated_at'] = now
                    if not info.get('results'):
                        info['results'] = []
                    result[0] = name
                    return
        self._atomic_update(_claim)
        return result[0]

    def heartbeat(self, image_name):
        def _hb(data):
            img = data['images'].get(image_name)
            if img:
                img['updated_at'] = datetime.now(timezone.utc).isoformat()
        self._atomic_update(_hb)

    def add_result(self, image_name, prompt_index, prompt, output_image, seed, success):
        def _add(data):
            img = data['images'].get(image_name)
            if not img:
                return
            while len(img['results']) <= prompt_index:
                img['results'].append(None)
            img['results'][prompt_index] = {
                "prompt_index": prompt_index,
                "status": "done" if success else "failed",
                "prompt": prompt,
                "output_image": output_image,
                "seed": seed
            }
            img['updated_at'] = datetime.now(timezone.utc).isoformat()
        self._atomic_update(_add)

    def add_char_meta(self, image_name, char_name, char_idx):
        """给图片进度附加角色名和索引"""
        def _add(data):
            img = data['images'].get(image_name)
            if img:
                img['char_name'] = char_name
                img['char_index'] = char_idx
        self._atomic_update(_add)

    def mark_done(self, image_name):
        def _done(data):
            img = data['images'].get(image_name)
            if img:
                img['status'] = 'done'
                img['completed_at'] = datetime.now(timezone.utc).isoformat()
        self._atomic_update(_done)

    def release_image(self, image_name):
        def _release(data):
            img = data['images'].get(image_name)
            if img and img['status'] == 'processing':
                img['status'] = 'pending'
                img.pop('assigned_port', None)
                img.pop('started_at', None)
        self._atomic_update(_release)

    def get_stats(self):
        data = self._read()
        total = len(data['images'])
        done = sum(1 for v in data['images'].values() if v['status'] == 'done')
        processing = sum(1 for v in data['images'].values() if v['status'] == 'processing')
        pending = sum(1 for v in data['images'].values() if v['status'] == 'pending')
        return total, done, processing, pending


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

    def get_image(self, filename, subfolder='', image_type='output'):
        params = {"filename": filename, "subfolder": subfolder, "type": image_type}
        r = requests.get(f"{self.base}/view", params=params, timeout=30)
        r.raise_for_status()
        return r.content

    def interrupt(self):
        try:
            requests.post(f"{self.base}/interrupt", timeout=5)
        except Exception:
            pass


# ═══════════════════════════════════════════════════
# 工作流
# ═══════════════════════════════════════════════════

class WorkflowManager:
    def __init__(self, workflow_path):
        with open(workflow_path, 'r', encoding='utf-8') as f:
            self.template = json.load(f)

    def build(self, image_filename, prompt, prompt_index, image_name):
        wf = json.loads(json.dumps(self.template))
        if '18' in wf:
            wf['18']['inputs']['image'] = image_filename
        if '17' in wf:
            wf['17']['inputs']['prompt'] = prompt
        seed = random.randint(0, 2_147_483_647)
        if '16' in wf:
            wf['16']['inputs']['seed'] = seed
        prefix = f"{Path(image_name).stem}_edit_{prompt_index:02d}"
        if '10' in wf:
            wf['10']['inputs']['filename_prefix'] = prefix
        return wf, seed, prefix

    @staticmethod
    def extract_seed_from_history(history):
        try:
            for node_id, node_output in history.get('outputs', {}).items():
                if 'seed' in node_output:
                    return node_output['seed']
        except Exception:
            pass
        return None

    @staticmethod
    def extract_output_filename(history):
        try:
            for node_id, node_output in history.get('outputs', {}).items():
                images = node_output.get('images', [])
                if images:
                    return images[0].get('filename'), images[0].get('subfolder', '')
        except Exception:
            pass
        return None, ''


# ═══════════════════════════════════════════════════
# Worker
# ═══════════════════════════════════════════════════

class Worker(threading.Thread):
    MAX_RETRIES = 3
    POLL_INTERVAL = 2
    MAX_WAIT = 300

    def __init__(self, port, host, shared_input_dir, output_dir,
                 progress, prompt_gen, workflow, prompts_per_image):
        super().__init__(daemon=True)
        self.port = port
        self.client = ComfyUIClient(host, port)
        self.shared_input_dir = shared_input_dir
        self.output_dir = Path(output_dir)
        self.progress = progress
        self.prompt_gen = prompt_gen
        self.workflow = workflow
        self.prompts_per_image = prompts_per_image
        self.running = True
        self.label = f"[{port}]"

    def log(self, msg):
        print(f"{self.label} {msg}", flush=True)

    def run(self):
        self.log("启动")
        if not self.client.check_health():
            self.log("ComfyUI 不可达, 退出")
            return

        while self.running:
            image_name = self.progress.claim_image(self.port)
            if image_name is None:
                self.log("无待处理图片, 退出")
                break

            char_idx, char = self.progress.image_to_char.get(image_name, (None, None))
            char_name = char['name'] if char else image_name
            self.progress.add_char_meta(image_name, char_name, char_idx)
            self.log(f"拿到: {image_name} → {char_name}")
            self._process_image(image_name, char_name)

        self.log("结束")

    def _process_image(self, image_name, char_name):
        input_dir = Path(self.progress._read().get('input_dir', ''))
        image_path = input_dir / image_name
        if not image_path.exists():
            self.log(f"图片不存在: {image_path}")
            self.progress.mark_done(image_name)
            return

        prompts = self.prompt_gen.generate_batch(self.prompts_per_image)

        try:
            self.client.upload_image(image_path, image_name, self.shared_input_dir)
        except Exception as e:
            self.log(f"上传失败: {e}")
            self.progress.release_image(image_name)
            return

        img_output_dir = self.output_dir / Path(image_name).stem
        img_output_dir.mkdir(parents=True, exist_ok=True)

        for idx, prompt in enumerate(prompts, start=1):
            self._run_single_prompt(image_name, char_name, prompt, idx, img_output_dir)
            self.progress.heartbeat(image_name)

        self.progress.mark_done(image_name)
        total, done, proc, pend = self.progress.get_stats()
        self.log(f"完成 {char_name} | 进度: {done}/{total}")

    def _run_single_prompt(self, image_name, char_name, prompt, prompt_index, output_dir):
        final_seed = None
        for attempt in range(1, self.MAX_RETRIES + 1):
            try:
                wf, seed, prefix = self.workflow.build(
                    image_name, prompt, prompt_index, image_name)
                prompt_id = self.client.submit_workflow(wf)
                self.log(f"  [{char_name}] #{prompt_index} id={prompt_id} seed={seed}")

                result = self._poll_until_done(prompt_id)
                if result is None:
                    raise RuntimeError("超时")

                output_filename, subfolder = result
                if output_filename:
                    img_bytes = self.client.get_image(output_filename, subfolder)
                    ext = Path(output_filename).suffix or '.png'
                    output_path = output_dir / f"edited_{prompt_index:02d}{ext}"
                    with open(output_path, 'wb') as f:
                        f.write(img_bytes)
                    output_rel = f"{Path(image_name).stem}/edited_{prompt_index:02d}{ext}"
                else:
                    output_rel = None

                actual_seed = WorkflowManager.extract_seed_from_history(
                    self.client.get_history(prompt_id) or {})
                final_seed = actual_seed or seed

                self.progress.add_result(
                    image_name, prompt_index, prompt, output_rel, final_seed, success=True)
                self.log(f"  [{char_name}] #{prompt_index} ✓")
                return

            except Exception as e:
                self.log(f"  [{char_name}] #{prompt_index} "
                          f"尝试{attempt}/{self.MAX_RETRIES} 失败: {e}")
                if attempt == self.MAX_RETRIES:
                    self.progress.add_result(
                        image_name, prompt_index, prompt, None, final_seed or seed,
                        success=False)
                    self.log(f"  [{char_name}] #{prompt_index} ✗ 最终失败")
                else:
                    time.sleep(5 * attempt)

    def _poll_until_done(self, prompt_id):
        start = time.time()
        while time.time() - start < self.MAX_WAIT:
            try:
                history = self.client.get_history(prompt_id)
                if history is not None:
                    return WorkflowManager.extract_output_filename(history)
            except Exception:
                pass
            time.sleep(self.POLL_INTERVAL)
        return None

    def stop(self):
        self.running = False
        self.client.interrupt()


# ═══════════════════════════════════════════════════
# 输出生成: 把结果写回角色 JSON
# ═══════════════════════════════════════════════════

def build_output_json(progress_path, orig_char_data, characters, image_to_char, output_dir):
    """
    读取进度文件, 把每个角色的编辑结果追加到 media 数组,
    输出完整的角色 JSON。
    """
    with open(progress_path, 'r', encoding='utf-8') as f:
        progress = json.load(f)

    images_data = progress.get('images', {})

    for image_name, img_info in images_data.items():
        char_idx, char = image_to_char.get(image_name, (None, None))
        if char_idx is None:
            continue

        for result_item in img_info.get('results', []):
            if result_item is None or result_item.get('status') != 'done':
                continue

            media_entry = {
                "type": "edited_image",
                "url": f"{output_dir}/{result_item['output_image']}",
                "prompt": result_item['prompt'],
                "seed": result_item['seed']
            }
            characters[char_idx].setdefault('media', []).append(media_entry)

    return orig_char_data


# ═══════════════════════════════════════════════════
# 主控
# ═══════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description='批量图片编辑 - 角色版')
    parser.add_argument('--character-json', type=str, required=True,
                        help='角色 JSON 文件路径')
    parser.add_argument('--input-dir', type=str, required=True,
                        help='输入图片目录 (girls/)')
    parser.add_argument('--output-dir', type=str, default=None,
                        help='输出图片目录 (默认 BASE/output/)')
    parser.add_argument('--output-json', type=str, default=None,
                        help='最终输出角色 JSON (默认 output-dir/characters_output.json)')
    parser.add_argument('--comfyui-shared-input', type=str, required=True,
                        help='ComfyUI 共享 input 目录')
    parser.add_argument('--workflow', type=str, required=True,
                        help='ComfyUI 工作流 JSON')
    parser.add_argument('--progress-file', type=str, default=None,
                        help='进度文件 (默认 output-dir/progress.json)')
    parser.add_argument('--prompts-per-image', type=int, default=10,
                        help='每角色生成几条编辑图 (默认 10)')
    parser.add_argument('--ports', type=str,
                        default='8188,8189,8190,8191,8192,8193,8194,8195',
                        help='ComfyUI 端口, 逗号分隔')
    parser.add_argument('--host', type=str, default='127.0.0.1',
                        help='ComfyUI 主机地址')
    parser.add_argument('--seed', type=int, default=None,
                        help='prompt 随机种子')
    args = parser.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    output_dir = Path(args.output_dir) if args.output_dir else BASE / 'output'
    output_dir.mkdir(parents=True, exist_ok=True)
    progress_file = args.progress_file or str(output_dir / 'progress.json')
    output_json = args.output_json or str(output_dir / 'characters_output.json')
    ports = [int(p.strip()) for p in args.ports.split(',') if p.strip()]

    # 1. 加载角色 → 图片映射
    print("── 加载角色数据 ──")
    orig_char_data, characters, image_to_char, unmatched = load_character_map(
        args.character_json, args.input_dir)
    print(f"  角色总数: {len(characters)}")
    print(f"  有图片匹配: {len(image_to_char)}")
    print(f"  无匹配图片: {len(unmatched)}")
    if unmatched:
        print(f"  无匹配角色 ({len(unmatched)} 个):")
        for idx, name in unmatched[:10]:
            print(f"    - {name}")
        if len(unmatched) > 10:
            print(f"    ... 还有 {len(unmatched) - 10} 个")
    if len(image_to_char) == 0:
        print("没有可处理的角色, 退出")
        return
    print()

    # 2. 检查端口
    print("── 检查 ComfyUI ──")
    alive, dead = [], []
    for p in ports:
        c = ComfyUIClient(args.host, p)
        if c.check_health():
            alive.append(p)
            print(f"  [{p}] ✓")
        else:
            dead.append(p)
            print(f"  [{p}] ✗")
    if not alive:
        print("无存活实例, 退出")
        sys.exit(1)
    print()

    # 3. 进度管理
    progress = ProgressManager(progress_file, image_to_char)
    progress.init_run(args.input_dir)
    progress.recover_stale()
    total, done, processing, pending = progress.get_stats()
    print(f"── 进度 ──")
    print(f"  总计: {total} | 已完成: {done} | 处理中: {processing} | 待处理: {pending}")
    if pending == 0:
        print("全部完成, 生成输出 JSON...")
        build_output_json(progress_file, orig_char_data, characters, image_to_char, str(output_dir))
        with open(output_json, 'w', encoding='utf-8') as f:
            json.dump(orig_char_data, f, ensure_ascii=False, indent=2)
        print(f"输出: {output_json}")
        return
    print()

    # 4. 启动 workers
    prompt_gen = PromptGenerator()
    workflow = WorkflowManager(args.workflow)
    print(f"── 启动 {len(alive)} 个 worker ──")
    workers = []
    for port in alive:
        w = Worker(port=port, host=args.host,
                   shared_input_dir=args.comfyui_shared_input,
                   output_dir=output_dir, progress=progress,
                   prompt_gen=prompt_gen, workflow=workflow,
                   prompts_per_image=args.prompts_per_image)
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

    # 5. 生成最终输出 JSON
    total, done, processing, pending = progress.get_stats()
    print(f"\n── 生成输出 JSON ──")
    print(f"  完成: {done}/{total}")
    result = build_output_json(progress_file, orig_char_data, characters,
                               image_to_char, str(output_dir))
    with open(output_json, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"  输出: {output_json}")
    print(f"  进度: {progress_file}")


if __name__ == '__main__':
    main()