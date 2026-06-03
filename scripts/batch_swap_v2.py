#!/usr/bin/env python3
"""
批量换脸脚本 v2

20张脸(output-v2匹配girls) × 170张body(selected) = 170张换脸结果
每张body图只用一次，随机分配给20张脸
"""

import copy
import json
import os
import random
import signal
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Optional

import requests

# ============ 路径配置 ============
SCRAPE_DIR = "/mnt/user/joseph/data/ScrapedData"

WORKFLOW_PATH = os.path.join(SCRAPE_DIR, "换脸生视频工作流.json")

BASE_DIR = os.path.join(SCRAPE_DIR, "virtual-gf-pose-library")
OUTPUT_V2_DIR = os.path.join(BASE_DIR, "output-v2")
GIRLS_DIR = os.path.join(BASE_DIR, "girls")
SELECTED_DIR = os.path.join(SCRAPE_DIR, "image_picker", "selected")

OUTPUT_BASE = os.path.join(BASE_DIR, "swaceface")
STATE_FILE = os.path.join(SCRAPE_DIR, "swaceface_v2_progress.json")

# ============ ComfyUI 配置 ============
# 工作流节点 ID（改工作流模板时记得同步）
NODE_BODY_IMAGE = "39"
NODE_FACE_IMAGE = "40"
NODE_NOISE_SEED = "23"
NODE_WIDTH_1 = "30"
NODE_HEIGHT_1 = "30"
NODE_WIDTH_2 = "31"
NODE_HEIGHT_2 = "31"

PORTS = [8188, 8189, 8190, 8191, 8192, 8193, 8194, 8195]
HOST = "localhost"
TIMEOUT = 600
MAX_RETRIES = 3
IMAGE_WIDTH = 512
IMAGE_HEIGHT = 512

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff",
                    ".JPG", ".JPEG", ".PNG", ".GIF", ".BMP", ".WEBP"}

# 优雅退出
shutdown_event = False


def handle_signal(signum, frame):
    global shutdown_event
    if shutdown_event:
        print("\n强制退出，可能丢失正在运行的任务状态")
        os._exit(1)
    shutdown_event = True
    print(f"\n[信号 {signum}] 正在优雅关闭，等待运行中的任务完成...")


signal.signal(signal.SIGINT, handle_signal)
signal.signal(signal.SIGTERM, handle_signal)


# ============ Task ============
@dataclass
class Task:
    id: str
    face_image: str
    body_image: str
    output_dir: str
    output_filename: str
    status: str = "pending"
    seed: Optional[int] = None
    port: Optional[int] = None
    prompt_id: Optional[str] = None
    result_files: list = field(default_factory=list)
    error: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    retries: int = 0


# ============ 进度管理 ============
class ProgressManager:
    def __init__(self, state_file: str):
        self.state_file = Path(state_file)
        self.tasks: list[Task] = []
        self.lock = Lock()
        self.load()

    def load(self):
        with self.lock:
            if self.state_file.exists():
                with open(self.state_file, encoding="utf-8") as f:
                    data = json.load(f)
                    self.tasks = [Task(**t) for t in data.get("tasks", [])]
                # 重启时把 running 的重置为 pending（避免僵死任务）
                for t in self.tasks:
                    if t.status == "running":
                        t.status = "pending"
                print(f"[断点恢复] 加载了 {len(self.tasks)} 个任务")

    def save(self):
        with self.lock:
            data = {
                "updated_at": datetime.now().isoformat(),
                "tasks": [asdict(t) for t in self.tasks]
            }
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self.state_file, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)

    def get_stats(self) -> dict:
        with self.lock:
            stats = {"pending": 0, "running": 0, "completed": 0, "failed": 0}
            for t in self.tasks:
                stats[t.status] = stats.get(t.status, 0) + 1
            return stats

    def get_pending_task(self) -> Optional[Task]:
        with self.lock:
            for t in self.tasks:
                if t.status == "pending":
                    t.status = "running"
                    return t
        return None

    def update_task(self, task: Task):
        with self.lock:
            for i, t in enumerate(self.tasks):
                if t.id == task.id:
                    self.tasks[i] = task
                    break
        self.save()

    @property
    def has_pending(self) -> bool:
        with self.lock:
            return any(t.status == "pending" for t in self.tasks)


# ============ ComfyUI 客户端 ============
class ComfyUIClient:
    def __init__(self, host: str, port: int):
        self.base_url = f"http://{host}:{port}"
        self.client_id = str(uuid.uuid4())

    def get_queue_size(self) -> int:
        try:
            resp = requests.get(f"{self.base_url}/queue", timeout=5)
            if resp.status_code == 200:
                data = resp.json()
                return len(data.get("queue_running", [])) + len(data.get("queue_pending", []))
        except Exception:
            pass
        return float('inf')

    def upload_image(self, image_path: str) -> str:
        url = f"{self.base_url}/upload/image"
        filename = os.path.basename(image_path)
        with open(image_path, "rb") as f:
            ext = Path(image_path).suffix.lower()
            mime = "image/png" if ext == ".png" else "image/jpeg"
            files = {"image": (filename, f, mime)}
            resp = requests.post(url, files=files)
        if resp.status_code != 200:
            raise Exception(f"上传失败: {resp.text}")
        return resp.json()["name"]

    def queue_prompt(self, workflow: dict) -> str:
        url = f"{self.base_url}/prompt"
        resp = requests.post(url, json={"prompt": workflow, "client_id": self.client_id})
        if resp.status_code != 200:
            raise Exception(f"提交失败: {resp.text}")
        return resp.json()["prompt_id"]

    def get_history(self, prompt_id: str) -> Optional[dict]:
        url = f"{self.base_url}/history/{prompt_id}"
        resp = requests.get(url)
        if resp.status_code == 200:
            return resp.json().get(prompt_id)
        return None

    def wait_for_completion(self, prompt_id: str, timeout: int = 1200) -> dict:
        start = time.time()
        while time.time() - start < timeout:
            if shutdown_event:
                raise KeyboardInterrupt("收到关闭信号，中止等待")
            history = self.get_history(prompt_id)
            if history:
                if "outputs" in history:
                    return history
                status = history.get("status", {})
                if status.get("status_str") == "error":
                    raise Exception(f"执行失败: {status.get('messages', [])}")
            time.sleep(3)
        raise TimeoutError(f"超时 ({timeout}秒)")

    def download_file(self, filename: str, subfolder: str, file_type: str, save_path: str):
        url = f"{self.base_url}/view"
        params = {"filename": filename, "subfolder": subfolder, "type": file_type}
        resp = requests.get(url, params=params)
        if resp.status_code == 200:
            with open(save_path, "wb") as f:
                f.write(resp.content)
            return True
        return False


# ============ 构建任务 ============
def build_tasks() -> list[Task]:
    """
    1. 从 output-v2 获取20个文件夹名 → 匹配 girls 里的脸图
    2. 从 selected 获取170张body图
    3. 随机打乱body图，均匀分配给20张脸（每张body只用一次）
    """
    # 获取20张脸
    ov2_folders = sorted(os.listdir(OUTPUT_V2_DIR))
    face_images = {}
    for folder_name in ov2_folders:
        if folder_name.startswith('.'):
            continue
        girl_file = os.path.join(GIRLS_DIR, f"{folder_name}.png")
        if os.path.exists(girl_file):
            face_images[folder_name] = girl_file
        else:
            print(f"[警告] 脸图不存在: {girl_file}")

    print(f"找到 {len(face_images)} 张脸图")

    # 获取所有body图
    body_images = []
    for f in sorted(os.listdir(SELECTED_DIR)):
        ext = Path(f).suffix
        if ext.lower() in IMAGE_EXTENSIONS or ext in IMAGE_EXTENSIONS:
            body_images.append(os.path.join(SELECTED_DIR, f))

    print(f"找到 {len(body_images)} 张body素材图")

    if not face_images or not body_images:
        raise RuntimeError("脸图或body图为空，请检查路径")

    # 随机打乱body图
    random.shuffle(body_images)

    # 按 round-robin 分配（均匀 + 每张body只用一次）
    face_names = sorted(face_images.keys())
    tasks = []
    for idx, body_path in enumerate(body_images):
        face_name = face_names[idx % len(face_names)]
        face_path = face_images[face_name]
        body_stem = Path(body_path).stem
        output_dir = os.path.join(OUTPUT_BASE, face_name)
        output_filename = f"{face_name}_{body_stem}.png"

        task = Task(
            id=str(uuid.uuid4())[:8],
            face_image=face_path,
            body_image=body_path,
            output_dir=output_dir,
            output_filename=output_filename,
            seed=random.randint(0, 2**31 - 1),
        )
        tasks.append(task)

    # 打印分配统计
    from collections import Counter
    dist = Counter(t.face_image for t in tasks)
    print("\n任务分配统计:")
    for face_name, cnt in sorted(dist.items(), key=lambda x: -x[1]):
        print(f"  {Path(face_name).name}: {cnt}张")

    return tasks


# ============ 运行单个任务 ============
def run_task(task: Task, port: int, workflow_template: dict, progress: ProgressManager):
    client = ComfyUIClient(HOST, port)

    task.status = "running"
    task.port = port
    task.started_at = datetime.now().isoformat()
    progress.update_task(task)

    face_stem = Path(task.face_image).stem
    body_stem = Path(task.body_image).stem
    print(f"[端口 {port}] 开始 {face_stem} <- {body_stem}")

    try:
        # 上传图片
        body_filename = client.upload_image(task.body_image)
        face_filename = client.upload_image(task.face_image)

        # 深拷贝工作流并注入参数
        workflow = copy.deepcopy(workflow_template)
        workflow[NODE_BODY_IMAGE]["inputs"]["image"] = body_filename
        workflow[NODE_FACE_IMAGE]["inputs"]["image"] = face_filename
        workflow[NODE_NOISE_SEED]["inputs"]["noise_seed"] = task.seed
        workflow[NODE_WIDTH_1]["inputs"]["width"] = IMAGE_WIDTH
        workflow[NODE_WIDTH_2]["inputs"]["width"] = IMAGE_WIDTH
        workflow[NODE_HEIGHT_1]["inputs"]["height"] = IMAGE_HEIGHT
        workflow[NODE_HEIGHT_2]["inputs"]["height"] = IMAGE_HEIGHT

        # 提交并等待
        prompt_id = client.queue_prompt(workflow)
        task.prompt_id = prompt_id

        history = client.wait_for_completion(prompt_id, timeout=TIMEOUT)

        # 下载结果
        output_dir = Path(task.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        result_files = []
        for node_id, output in history.get("outputs", {}).items():
            for img_i, img in enumerate(output.get("images", [])):
                # 多张图时加后缀避免覆盖
                save_name = task.output_filename
                if img_i > 0:
                    stem = Path(save_name).stem
                    ext = Path(save_name).suffix
                    save_name = f"{stem}_{img_i}{ext}"
                save_path = output_dir / save_name
                if client.download_file(img["filename"], img.get("subfolder", ""),
                                        img.get("type", "output"), str(save_path)):
                    result_files.append(str(save_path))

        task.status = "completed"
        task.result_files = result_files
        task.completed_at = datetime.now().isoformat()
        progress.update_task(task)
        print(f"[端口 {port}] 完成 {task.output_filename}")
        return True

    except KeyboardInterrupt:
        task.status = "pending"
        progress.update_task(task)
        print(f"[端口 {port}] 中止 {task.id}，已重置为pending")
        return False
    except Exception as e:
        task.status = "failed"
        task.error = str(e)
        task.retries += 1
        progress.update_task(task)
        print(f"[端口 {port}] 失败 {task.id}: {e}")
        return False


# ============ 并行调度 ============
def run_all(progress: ProgressManager, workflow_template: dict):
    # 重试失败的任务
    with progress.lock:
        for t in progress.tasks:
            if t.status == "failed" and t.retries < MAX_RETRIES:
                t.status = "pending"
    progress.save()

    stats = progress.get_stats()
    if stats["pending"] == 0:
        print("没有待处理的任务")
        return

    print(f"\n开始并行处理 ({len(PORTS)} 个端口)")
    print(f"初始状态: {stats}")
    print("=" * 60)

    total_completed = 0
    total_failed = 0
    future_to_port: dict = {}

    with ThreadPoolExecutor(max_workers=len(PORTS)) as executor:
        # 初始分配
        for port in PORTS:
            if shutdown_event:
                break
            task = progress.get_pending_task()
            if task:
                future = executor.submit(run_task, task, port, workflow_template, progress)
                future_to_port[future] = port

        # 持续调度直到所有任务完成
        while future_to_port and not shutdown_event:
            done_futures = []
            for future in list(future_to_port):
                if future.done():
                    done_futures.append(future)
            if not done_futures:
                time.sleep(0.5)
                continue

            for future in done_futures:
                port = future_to_port.pop(future)
                try:
                    success = future.result()
                    if success:
                        total_completed += 1
                    else:
                        total_failed += 1
                except Exception as e:
                    print(f"任务异常: {e}")
                    total_failed += 1

                if shutdown_event:
                    continue

                # 端口完成后领新任务
                new_task = progress.get_pending_task()
                if new_task:
                    new_future = executor.submit(run_task, new_task, port, workflow_template, progress)
                    future_to_port[new_future] = port

                stats = progress.get_stats()
                print(f"进度: 完成={stats['completed']}, 失败={stats['failed']}, "
                      f"运行中={stats['running']}, 待处理={stats['pending']}")

    # 最终报告
    print("\n" + "=" * 60)
    final = progress.get_stats()
    print(f"全部完成! {final}")
    if total_failed > 0:
        failed = [t for t in progress.tasks if t.status == "failed"]
        print(f"\n失败任务 ({len(failed)}):")
        for t in failed[:5]:
            print(f"  {t.id}: {t.error}")


def main():
    with open(WORKFLOW_PATH, encoding="utf-8") as f:
        workflow_template = json.load(f)

    progress = ProgressManager(STATE_FILE)

    if not progress.tasks:
        tasks = build_tasks()
        progress.tasks = tasks
        progress.save()

    stats = progress.get_stats()
    print(f"任务统计: {stats}")
    print(f"总任务数: {len(progress.tasks)}")

    run_all(progress, workflow_template)


if __name__ == "__main__":
    main()
