#!/usr/bin/env python3
"""
Z-Image 批量图片生成脚本
用法:
  python3 batch_generate.py                  # 使用默认配置
  python3 batch_generate.py 0 50             # 生成 0-50
  python3 batch_generate.py 50 100           # 生成 50-100
"""

import json
import os
import sys
import time
import random
import urllib.request
import urllib.parse
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

# ─── 配置 ───────────────────────────────────────────────────────
COMFYUI_PORTS = list(range(8188, 8196))
WORKFLOW_FILE = "/mnt/user/joseph/data/ScrapedData/Z-Image+Base+&+Turbo+双重采样工作流-cypher (2).json"
PROMPTS_FILE = "/mnt/user/joseph/data/ScrapedData/anime_girlfriend_prompts.json"
OUTPUT_DIR = "/mnt/user/joseph/data/ScrapedData/IndianRole/generated_output_anime"
MAPPING_FILE = os.path.join(OUTPUT_DIR, "image_prompt_mapping.json")
MAX_WORKERS = 8
POLL_INTERVAL = 3
MAX_POLL_TIME = 600
NODE_POSITIVE_PROMPT = "47"
NODE_NEGATIVE_PROMPT = "7"
NODE_SEED = "43"
NODE_FILENAME = "35"
_default_negative = "blurry, ugly, bad anatomy, deformed, low quality"


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def comfyui_api(port, endpoint, data=None):
    url = f"http://127.0.0.1:{port}{endpoint}"
    try:
        if data is not None:
            body = json.dumps(data).encode("utf-8")
            req = urllib.request.Request(url, data=body, method="POST")
            req.add_header("Content-Type", "application/json")
        else:
            req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except:
        return None


def comfyui_download(port, filename, subfolder="", folder_type="output"):
    params = urllib.parse.urlencode({"filename": filename, "subfolder": subfolder, "type": folder_type})
    url = f"http://127.0.0.1:{port}/view?{params}"
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            return resp.read()
    except:
        return None


def find_working_port():
    random.shuffle(COMFYUI_PORTS)
    for p in COMFYUI_PORTS:
        r = comfyui_api(p, "/system_stats")
        if r:
            return p
    return None


def build_workflow(wf_tpl, prompt_text, seed, filename_prefix):
    wf = json.loads(json.dumps(wf_tpl))
    wf[NODE_POSITIVE_PROMPT]["inputs"]["text"] = prompt_text
    wf[NODE_NEGATIVE_PROMPT]["inputs"]["text"] = _default_negative
    wf[NODE_SEED]["inputs"]["seed"] = seed
    wf[NODE_FILENAME]["inputs"]["filename_prefix"] = filename_prefix
    return wf


def submit_and_wait(port, wf):
    result = comfyui_api(port, "/prompt", {"prompt": wf})
    if not result or "prompt_id" not in result:
        return None, []
    prompt_id = result["prompt_id"]
    deadline = time.time() + MAX_POLL_TIME
    while time.time() < deadline:
        history = comfyui_api(port, f"/history/{prompt_id}")
        if history and prompt_id in history:
            status = history[prompt_id].get("status", {})
            if status.get("completed"):
                images = []
                for outputs in history[prompt_id].get("outputs", {}).values():
                    for img in outputs.get("images", []):
                        if isinstance(img, dict) and "filename" in img and img.get("type") == "output":
                            images.append({"filename": img["filename"], "subfolder": img.get("subfolder", "")})
                return prompt_id, images
            if status.get("status_str") == "error":
                return prompt_id, []
        time.sleep(POLL_INTERVAL)
    return prompt_id, []


def extract_prompt_info(item, idx):
    if isinstance(item, dict):
        pid = item.get("id", idx + 1)
        region = item.get("region", item.get("anime_region", "Unknown"))
        skin = item.get("skin_tone", "unknown")
        body = item.get("body_type", "unknown")
        prompt_text = item.get("prompt", item.get("anime_prompt", ""))
    else:
        pid = idx + 1
        region = "Unknown"
        skin = "unknown"
        body = "unknown"
        prompt_text = item
    return pid, region, skin, body, prompt_text


def run_one(item, idx, wf_tpl, results_list, results_lock, stats, stats_lock):
    pid, region, skin, body, prompt_text = extract_prompt_info(item, idx)
    if not prompt_text:
        with stats_lock:
            stats["failed"] += 1
        return

    seed = random.randint(1, 2 ** 32 - 1)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_region = region.replace(" ", "_")
    filename_prefix = f"indian_beauty_v2/{ts}_{safe_region}_{pid:03d}_ZImage"

    port = find_working_port()
    if port is None:
        print(f"  ❌ [{pid:03d}] 无可用 ComfyUI!")
        with stats_lock:
            stats["failed"] += 1
        return

    print(f"  ⏳ [{pid:03d}] port={port} | {region} | {prompt_text[:40]}...")

    wf = build_workflow(wf_tpl, prompt_text, seed, filename_prefix)
    returned_pid, images = submit_and_wait(port, wf)

    if not images:
        print(f"  ❌ [{pid:03d}] 生成失败 (pid={returned_pid})")
        with stats_lock:
            stats["failed"] += 1
        return

    local_paths = []
    for i, img_info in enumerate(images):
        img_data = comfyui_download(port, img_info["filename"], img_info.get("subfolder", ""), "output")
        if not img_data:
            img_data = comfyui_download(port, img_info["filename"], img_info.get("subfolder", ""), "temp")
        if img_data:
            ext = ".png"
            local_name = f"{ts}_{safe_region}_{pid:03d}_ZImage{ext}"
            if len(images) > 1:
                local_name = f"{ts}_{safe_region}_{pid:03d}_ZImage_{i+1}{ext}"
            local_path = os.path.join(OUTPUT_DIR, local_name)
            with open(local_path, "wb") as f:
                f.write(img_data)
            local_paths.append(local_name)
            print(f"  📥 [{pid:03d}] 已下载: {local_name} ({len(img_data)//1024}KB)")

    record = {
        "id": pid, "region": region, "skin_tone": skin, "body_type": body,
        "seed": seed, "port": port, "prompt_id": returned_pid,
        "filename_prefix": filename_prefix, "image_files": local_paths,
        "prompt_text": prompt_text,
    }
    with results_lock:
        results_list.append(record)
    print(f"  ✅ [{pid:03d}] 完成!")


if __name__ == "__main__":
    print("=" * 60)
    print("  Z-Image 批量生成 —— V2 Batch")
    print("=" * 60)
    print(f"  提示词: {PROMPTS_FILE}")
    print(f"  输出: {OUTPUT_DIR}")
    print(f"  并行: {MAX_WORKERS}")
    print("=" * 60)

    wf_tpl = load_json(WORKFLOW_FILE)
    prompts_data = load_json(PROMPTS_FILE)
    all_prompts = prompts_data.get("prompts", prompts_data) if isinstance(prompts_data, dict) else prompts_data

    start_idx, end_idx = 0, len(all_prompts)
    if len(sys.argv) >= 3:
        start_idx, end_idx = int(sys.argv[1]), int(sys.argv[2])
    batch = all_prompts[start_idx:end_idx]

    print(f"  共 {len(batch)} 条 (索引 {start_idx}-{end_idx})\n")
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    results, rlock = [], Lock()
    stats, slock = {"done": 0, "failed": 0}, Lock()

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs = {pool.submit(run_one, item, start_idx+i, wf_tpl, results, rlock, stats, slock): item for i, item in enumerate(batch)}
        for f in as_completed(futs):
            try:
                f.result()
            except Exception as e:
                print(f"  💥 异常: {e}")
                with slock: stats["failed"] += 1

    results.sort(key=lambda x: x["id"])
    mapping = {
        "meta": {"generated_at": datetime.now().isoformat(), "total": len(results), "failed": stats["failed"]},
        "mappings": [{"id": r["id"], "region": r["region"], "seed": r["seed"], "image_files": r["image_files"], "prompt_text": r["prompt_text"]} for r in results]
    }
    with open(MAPPING_FILE, "w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=2, ensure_ascii=False)

    print(f"\n{'='*60}")
    print(f"  完成! 成功 {len(results)} 张, 失败 {stats['failed']} 张")
    print(f"  映射: {MAPPING_FILE}")
    print(f"  图片: {OUTPUT_DIR}")
    print(f"{'='*60}\n")
