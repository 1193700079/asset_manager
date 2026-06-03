#!/usr/bin/env python3
"""
批量换脸脚本 - 基于mapping.json映射

每张girls图片(face)替换10张素材图片(body)的脸
结果按角色分目录存放: output/swaceface/{face_name}/
"""

import json
import os
import random
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Optional

import requests

WORKFLOW_PATH = r"C:\project\tool\workflows\换脸生视频工作流.json"
MAPPING_PATH = r"C:\project\tool\output\mapping.json"
OUTPUT_BASE = r"C:\project\tool\output\swaceface"
STATE_FILE = r"C:\project\tool\output\swaceface_progress.json"
GIRLS_DIR = r"C:\project\tool\output\girls"

PORTS = [8188, 8189, 8190, 8191, 8192, 8193, 8194, 8195]
HOST = "localhost"
TIMEOUT = 600
MAX_RETRIES = 3
IMAGE_WIDTH = 512
IMAGE_HEIGHT = 512

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".ico",
                    ".JPG", ".JPEG", ".PNG", ".GIF", ".BMP", ".WEBP"}


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
                print(f"[断点恢复] 加载了 {len(self.tasks)} 个任务")

    def save(self):
        with self.lock:
            data = {
                "updated_at": datetime.now().isoformat(),
                "tasks": [asdict(t) for t in self.tasks]
            }
            with open(self.state_file, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)

    def get_stats(self) -> dict:
        with self.lock:
            stats = {"pending": 0, "running": 0, "completed": 0, "failed": 0}
            for t in self.tasks:
                stats[t.status] = stats.get(t.status, 0) + 1
            return stats

    def get_pending_tasks(self, count: int = 1) -> list[Task]:
        with self.lock:
            pending = [t for t in self.tasks if t.status == "pending"][:count]
            for task in pending:
                task.status = "running"
            return pending

    def get_failed_tasks(self, max_retries: int = 3) -> list[Task]:
        with self.lock:
            return [t for t in self.tasks if t.status == "failed" and t.retries < max_retries]

    def update_task(self, task: Task):
        with self.lock:
            for i, t in enumerate(self.tasks):
                if t.id == task.id:
                    self.tasks[i] = task
                    break
        self.save()


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
        except:
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


def build_tasks_from_mapping():
    with open(MAPPING_PATH, encoding="utf-8") as f:
        mapping = json.load(f)

    with open(WORKFLOW_PATH, encoding="utf-8") as f:
        workflow = json.load(f)

    tasks = []
    for face_name, body_images in mapping.items():
        face_path = os.path.join(GIRLS_DIR, face_name)
        if not os.path.exists(face_path):
            print(f"[警告] Face图片不存在: {face_path}")
            continue

        face_stem = Path(face_name).stem
        output_dir = os.path.join(OUTPUT_BASE, face_stem)

        for i, body_path in enumerate(body_images):
            if not os.path.exists(body_path):
                print(f"[警告] Body图片不存在: {body_path}")
                continue

            body_name = Path(body_path).stem
            output_filename = f"{face_stem}_{body_name}.png"

            task = Task(
                id=str(uuid.uuid4())[:8],
                face_image=face_path,
                body_image=body_path,
                output_dir=output_dir,
                output_filename=output_filename,
            )
            tasks.append(task)

    return tasks


def run_task(task: Task, port: int, workflow_template: dict, progress: ProgressManager):
    client = ComfyUIClient(HOST, port)

    task.status = "running"
    task.port = port
    task.started_at = datetime.now().isoformat()
    progress.update_task(task)

    face_stem = Path(task.face_image).stem
    body_name = Path(task.body_image).name
    print(f"[端口 {port}] 开始 {face_stem} <- {body_name}")

    try:
        body_filename = client.upload_image(task.body_image)
        face_filename = client.upload_image(task.face_image)

        workflow = json.loads(json.dumps(workflow_template))
        workflow["39"]["inputs"]["image"] = body_filename
        workflow["40"]["inputs"]["image"] = face_filename

        if task.seed is None:
            task.seed = random.randint(0, 2**31 - 1)
        workflow["23"]["inputs"]["noise_seed"] = task.seed

        workflow["30"]["inputs"]["width"] = IMAGE_WIDTH
        workflow["30"]["inputs"]["height"] = IMAGE_HEIGHT
        workflow["31"]["inputs"]["width"] = IMAGE_WIDTH
        workflow["31"]["inputs"]["height"] = IMAGE_HEIGHT

        prompt_id = client.queue_prompt(workflow)
        task.prompt_id = prompt_id

        history = client.wait_for_completion(prompt_id, timeout=TIMEOUT)

        output_dir = Path(task.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        result_files = []
        for node_id, output in history.get("outputs", {}).items():
            for img in output.get("images", []):
                save_path = output_dir / task.output_filename
                if client.download_file(img["filename"], img.get("subfolder", ""),
                                       img.get("type", "output"), str(save_path)):
                    result_files.append(str(save_path))

        task.status = "completed"
        task.result_files = result_files
        task.completed_at = datetime.now().isoformat()
        progress.update_task(task)
        print(f"[端口 {port}] 完成 {face_stem}_{Path(task.body_image).stem} -> {task.output_filename}")
        return True

    except Exception as e:
        task.status = "failed"
        task.error = str(e)
        task.retries += 1
        progress.update_task(task)
        print(f"[端口 {port}] 失败 {task.id}: {e}")
        return False


def run_all(progress: ProgressManager, workflow_template: dict):
    for task in progress.get_failed_tasks(MAX_RETRIES):
        task.status = "pending"
    progress.save()

    stats = progress.get_stats()
    if stats["pending"] == 0:
        print("没有待处理的任务")
        return

    print(f"\n开始并行处理 (端口: {PORTS})")
    print(f"初始状态: {stats}")
    print("=" * 60)

    total_completed = 0
    total_failed = 0
    future_to_port = {}

    with ThreadPoolExecutor(max_workers=len(PORTS)) as executor:
        for port in PORTS:
            pending = progress.get_pending_tasks(1)
            if pending:
                task = pending[0]
                future = executor.submit(run_task, task, port, workflow_template, progress)
                future_to_port[future] = port

        while future_to_port:
            for future in as_completed(future_to_port, timeout=TIMEOUT + 60):
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

                pending = progress.get_pending_tasks(1)
                if pending:
                    new_task = pending[0]
                    new_future = executor.submit(run_task, new_task, port, workflow_template, progress)
                    future_to_port[new_future] = port
                else:
                    print(f"[空闲] 端口 {port} 完成，无待处理任务")

                stats = progress.get_stats()
                print(f"进度: 完成={stats['completed']}, 失败={stats['failed']}, "
                      f"运行中={stats['running']}, 待处理={stats['pending']}")
                break

    print("\n" + "=" * 60)
    print(f"全部完成! 完成={total_completed}, 失败={total_failed}")


def main():
    with open(WORKFLOW_PATH, encoding="utf-8") as f:
        workflow_template = json.load(f)

    progress = ProgressManager(STATE_FILE)

    if not progress.tasks:
        tasks = build_tasks_from_mapping()
        progress.tasks = tasks
        progress.save()

    stats = progress.get_stats()
    print(f"任务统计: {stats}")
    print(f"总任务数: {len(progress.tasks)}")

    run_all(progress, workflow_template)


if __name__ == "__main__":
    main()