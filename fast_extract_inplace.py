#!/usr/bin/env python3
"""
Fast In-place Archive Extractor v4 (Verbose Progress)
- 单文件级实时进度输出
- 正在处理的任务可见
- 系统 find 极速扫描 + 并行预检
- 同分区 mv 原子操作 + 增量跳过
"""

import os
import sys
import shutil
import subprocess
import threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict
import time

# === 配置 ===
SOURCE_DIR = Path("/mnt/data")
MAX_WORKERS = min(os.cpu_count() or 4, 8)
DRY_RUN = "--dry-run" in sys.argv

EXTRACTORS = {
    ".zip":     ["unzip", "-o", "-q", "{src}", "-d", "{dst}"],
    ".rar":     ["unrar", "x", "-o+", "-inul", "{src}", "{dst}/"],
    ".7z":      ["7z", "x", "{src}", f"-o{{dst}}", "-y", "-bso0", "-bsp0"],
    ".tar.gz":  ["tar", "-xzf", "{src}", "-C", "{dst}"],
    ".tgz":     ["tar", "-xzf", "{src}", "-C", "{dst}"],
    ".tar.bz2": ["tar", "-xjf", "{src}", "-C", "{dst}"],
    ".tbz2":    ["tar", "-xjf", "{src}", "-C", "{dst}"],
    ".tar.xz":  ["tar", "-xJf", "{src}", "-C", "{dst}"],
    ".txz":     ["tar", "-xJf", "{src}", "-C", "{dst}"],
    ".tar":     ["tar", "-xf", "{src}", "-C", "{dst}"],
}

# === 线程安全的进度计数器 ===
class ProgressTracker:
    def __init__(self, total: int):
        self.total = total
        self.done = 0
        self.success = 0
        self.failed = 0
        self.lock = threading.Lock()
        self.start_time = time.time()
        self.active_tasks: dict[int, str] = {}  # thread_id -> filename

    def start_task(self, name: str):
        tid = threading.current_thread().ident
        with self.lock:
            self.active_tasks[tid] = name
            self._print_active()

    def finish_task(self, result: dict):
        tid = threading.current_thread().ident
        with self.lock:
            self.active_tasks.pop(tid, None)
            self.done += 1
            if result["status"] in ("done", "dry_run"):
                self.success += 1
                tag = "🧪" if result["status"] == "dry_run" else "✅"
            else:
                self.failed += 1
                tag = "❌"

            elapsed = time.time() - self.start_time
            rate = self.done / elapsed if elapsed > 0 else 0
            pct = self.done / self.total * 100

            extra = f" | {result['time']:>6.1f}s | {result.get('files_moved', 0):>3} files"
            print(f"  [{self.done:>4}/{self.total} {pct:>5.1f}%] {tag} "
                  f"{result['src'].name:<45s} {rate:.1f} pkg/s{extra}", flush=True)

    def _print_active(self):
        """显示当前正在处理的任务（可选，避免刷屏）"""
        pass  # 保持输出整洁，仅在完成时打印


def get_extractor(filepath: Path):
    name_lower = filepath.name.lower()
    for ext, cmd_template in EXTRACTORS.items():
        if name_lower.endswith(ext):
            return cmd_template
    return None


def is_already_extracted(src: Path) -> bool:
    expected_dir = src.parent / src.stem
    if not expected_dir.is_dir():
        return False
    try:
        dir_mtime = expected_dir.stat().st_mtime
        src_mtime = src.stat().st_mtime
        if dir_mtime < src_mtime:
            return False
        with os.scandir(expected_dir) as it:
            return any(True for _ in it)
    except (PermissionError, OSError):
        return True


def scan_with_find(root: Path) -> list[Path]:
    supported_exts = list(EXTRACTORS.keys())
    name_args = []
    for i, ext in enumerate(supported_exts):
        if i > 0:
            name_args.append("-o")
        name_args.extend(["-name", f"*{ext}"])

    cmd = ["find", str(root), "-type", "f", "("] + name_args + [")"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            print(f"  ⚠️  find warning: {result.stderr.strip()[:200]}")
        paths = [Path(line) for line in result.stdout.strip().split("\n") if line]
        return [p for p in paths if ".tmp_extract_" not in str(p)]
    except FileNotFoundError:
        print("  ⚠️  'find' not available, falling back to os.walk")
        return _scan_fallback(root)
    except subprocess.TimeoutExpired:
        print("  ⚠️  find timed out, falling back to os.walk")
        return _scan_fallback(root)


def _scan_fallback(root: Path) -> list[Path]:
    archives = []
    supported_exts = set(EXTRACTORS.keys())
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".tmp_extract_")]
        for fname in filenames:
            name_lower = fname.lower()
            if any(name_lower.endswith(ext) for ext in supported_exts):
                archives.append(Path(dirpath) / fname)
    return archives


def parallel_filter(archives: list[Path], workers: int) -> tuple[list[Path], int]:
    to_extract = []
    skipped = 0
    if not archives:
        return to_extract, skipped

    with ThreadPoolExecutor(max_workers=workers) as pool:
        future_map = {pool.submit(is_already_extracted, arc): arc for arc in archives}
        done = 0
        total = len(future_map)
        for future in as_completed(future_map):
            done += 1
            arc = future_map[future]
            try:
                if future.result():
                    skipped += 1
                else:
                    to_extract.append(arc)
            except Exception:
                to_extract.append(arc)
            if done % 1000 == 0 or done == total:
                pct = done / total * 100
                print(f"    Filtering: [{done}/{total}] {pct:.0f}% | skip={skipped}", flush=True)
    return to_extract, skipped


def extract_one(src: Path, tracker: ProgressTracker) -> dict:
    """解压单个文件，实时上报进度"""
    tracker.start_task(src.name)
    result = {"src": str(src), "status": "ok", "files_moved": 0, "time": 0}
    t0 = time.time()
    temp_dir = None

    try:
        cmd_template = get_extractor(src)
        if not cmd_template:
            result["status"] = "unsupported_format"
            return result

        final_dir = src.parent / src.stem
        if final_dir.exists() and any(final_dir.iterdir()):
            suffix = 1
            while True:
                new_dir = src.parent / f"{src.stem}_{suffix}"
                if not new_dir.exists():
                    final_dir = new_dir
                    break
                suffix += 1

        temp_dir = src.parent / f".tmp_extract_{src.stem}_{os.getpid()}_{id(src)}"
        temp_dir.mkdir(parents=True, exist_ok=True)

        cmd = [part.format(src=str(src), dst=str(temp_dir)) for part in cmd_template]

        if DRY_RUN:
            result["status"] = "dry_run"
            result["target"] = str(final_dir)
            return result

        proc = subprocess.run(
            cmd, capture_output=True, timeout=7200,
            preexec_fn=lambda: os.nice(10) if hasattr(os, 'nice') else None
        )

        if proc.returncode != 0:
            err_msg = proc.stderr.decode(errors="replace").strip()[:300]
            result["status"] = f"extract_failed(rc={proc.returncode}): {err_msg}"
            return result

        moved = 0
        final_dir.mkdir(parents=True, exist_ok=True)
        for item in temp_dir.iterdir():
            dest = final_dir / item.name
            if dest.exists():
                s = 1
                stem, suffix_ext = item.stem, item.suffix
                while True:
                    dest = final_dir / f"{stem}_{s}{suffix_ext}"
                    if not dest.exists():
                        break
                    s += 1
            try:
                os.rename(str(item), str(dest))
            except OSError:
                shutil.move(str(item), str(dest))
            moved += 1

        result["files_moved"] = moved
        result["target"] = str(final_dir)
        result["status"] = "done"

    except subprocess.TimeoutExpired:
        result["status"] = "timeout_2h"
    except Exception as e:
        result["status"] = f"error: {type(e).__name__}: {e}"
    finally:
        if temp_dir and temp_dir.exists():
            shutil.rmtree(temp_dir, ignore_errors=True)
        result["time"] = round(time.time() - t0, 2)
        tracker.finish_task(result)

    return result


def main():
    print("=" * 60)
    print("  FAST EXTRACTOR v4 (VERBOSE PROGRESS)")
    print(f"  Source : {SOURCE_DIR}")
    print(f"  Workers: {MAX_WORKERS}")
    print(f"  Dry Run: {DRY_RUN}")
    print("=" * 60)

    if not SOURCE_DIR.exists():
        print(f"\n❌ Source not found: {SOURCE_DIR}")
        sys.exit(1)

    # 1. 极速扫描
    print("\n🔍 Scanning archives (using system find)...")
    t0 = time.time()
    all_archives = scan_with_find(SOURCE_DIR)
    scan_time = time.time() - t0
    print(f"   Found {len(all_archives)} archives in {scan_time:.1f}s")

    if not all_archives:
        print("✅ No archives found.")
        return 0

    # 2. 并行预检
    print(f"\n🔎 Parallel filtering ({MAX_WORKERS} workers)...")
    t1 = time.time()
    to_extract, pre_skipped = parallel_filter(all_archives, MAX_WORKERS)
    filter_time = time.time() - t1
    print(f"   Skipped: {pre_skipped} | To extract: {len(to_extract)} | Filter took {filter_time:.1f}s\n")

    if not to_extract:
        print("✅ All archives already extracted.")
        return 0

    # 3. 实时进度解压
    total = len(to_extract)
    tracker = ProgressTracker(total)

    print(f"📦 Extracting {total} archives with real-time progress:\n")

    errors_detail = []
    results = []

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(extract_one, arc, tracker): arc for arc in to_extract}
        for future in as_completed(futures):
            r = future.result()
            results.append(r)
            if r["status"] not in ("done", "dry_run"):
                errors_detail.append(r)

    # 4. 汇总报告
    total_time = time.time() - tracker.start_time
    print("\n" + "=" * 60)
    print(f"🏁 Completed in {total_time:.1f}s")
    print(f"   Extracted: {tracker.success} | Pre-skipped: {pre_skipped} | "
          f"Failed: {tracker.failed} | Total: {total + pre_skipped}")

    if errors_detail:
        print(f"\n❌ Errors ({len(errors_detail)}):")
        for r in errors_detail[:20]:
            print(f"   {r['src']}\n     → {r['status']}")
        if len(errors_detail) > 20:
            print(f"   ... +{len(errors_detail) - 20} more")

    print("=" * 60)
    return 1 if tracker.failed > 0 else 0


if __name__ == "__main__":
    sys.exit(main())