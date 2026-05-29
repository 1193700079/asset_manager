#!/usr/bin/env python3
"""
Asset Organizer v2 - Additional Sources
Phase 1: Build MD5 index of existing organized assets
Phase 2: Scan new sources, compute MD5, cross-dedup
Phase 3: Symlink new unique files
Phase 4: Extract 4s frames from adult_content_videos
"""

import hashlib
import os
import subprocess
import sys
import time
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from pathlib import Path

# ============================================================
# CONFIG
# ============================================================

OUTPUT_ROOT = Path("/mnt/cypher/project/asset_manager")
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".avif", ".heic", ".heif"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".flv", ".wmv", ".m4v"}
MD5_WORKERS = 16
FRAME_WORKERS = 24
FRAME_AT_SEC = 4.0

# New sources: (category, media_type, source_path, recursive)
NEW_SOURCES = [
    ("spicy_adult",       "video", Path("/root/spicy_data/adult_content_videos"), False),
    ("jason_photo",       "image", Path("/mnt/user/jason/project/work/crawel_spicy_url/spicy_data/photo"), True),
    ("jason_video",       "video", Path("/mnt/user/jason/project/work/crawel_spicy_url/spicy_data/video"), True),
]


def md5_file(filepath: Path) -> tuple[str, Path]:
    """Compute MD5. Returns (hex, filepath)."""
    h = hashlib.md5()
    try:
        resolved = filepath.resolve()
        with open(resolved, "rb") as f:
            while True:
                chunk = f.read(131072)  # 128KB
                if not chunk:
                    break
                h.update(chunk)
        return (h.hexdigest(), filepath)
    except Exception as e:
        return (None, filepath)


def md5_file_standalone(args):
    """Standalone version for ProcessPoolExecutor."""
    filepath = Path(args)
    h = hashlib.md5()
    try:
        resolved = filepath.resolve()
        with open(resolved, "rb") as f:
            while True:
                chunk = f.read(131072)
                if not chunk:
                    break
                h.update(chunk)
        return (h.hexdigest(), str(filepath))
    except Exception:
        return (None, str(filepath))


def extract_frame(args):
    """Extract a single frame at 4s from a video file."""
    src_path, dst_path = args
    try:
        # Check video duration first
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(src_path)],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            return (str(src_path), False, "ffprobe failed")

        duration = float(result.stdout.strip())
        seek_time = min(FRAME_AT_SEC, max(0, duration - 0.5))

        cmd = [
            "ffmpeg", "-y",
            "-ss", str(seek_time),
            "-i", str(src_path),
            "-vframes", "1",
            "-q:v", "2",
            str(dst_path),
        ]
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            return (str(src_path), False, result.stderr[-150:])

        if not dst_path.exists() or dst_path.stat().st_size < 1024:
            return (str(src_path), False, f"output too small ({dst_path.stat().st_size}b)" if dst_path.exists() else "no output")

        return (str(src_path), True, f"ok ({dst_path.stat().st_size // 1024}KB)")
    except subprocess.TimeoutExpired:
        return (str(src_path), False, "timeout")
    except Exception as e:
        return (str(src_path), False, str(e))


def scan_existing():
    """Phase 1: Build MD5 index of existing organized assets."""
    print("\n[PHASE 1] Building MD5 index of existing organized assets...")

    existing_files = []
    for subdir in ["images", "videos"]:
        base = OUTPUT_ROOT / subdir
        if not base.exists():
            continue
        for cat_dir in base.iterdir():
            if not cat_dir.is_dir():
                continue
            for f in cat_dir.iterdir():
                if f.is_symlink():
                    real = f.resolve()
                    if real.exists():
                        existing_files.append(real)

    print(f"  Found {len(existing_files)} existing asset files")

    # Compute MD5s
    existing_md5s = set()
    done = 0
    with ProcessPoolExecutor(max_workers=MD5_WORKERS) as pool:
        futures = {pool.submit(md5_file_standalone, str(f)): f for f in existing_files}
        for future in as_completed(futures):
            h, _ = future.result()
            if h:
                existing_md5s.add(h)
            done += 1
            if done % 2000 == 0:
                print(f"  ... {done}/{len(existing_files)} indexed")

    print(f"  Indexed {len(existing_md5s)} unique MD5 hashes from existing assets")
    return existing_md5s


def scan_new_sources():
    """Scan new source directories and return (category, media_type, filepath) tuples."""
    print("\n[PHASE 2] Scanning new source directories...")
    all_files = []
    for cat, mtype, src_path, recursive in NEW_SOURCES:
        if not src_path.exists():
            print(f"  [SKIP] {src_path} not found")
            continue

        files = []
        if recursive:
            for root, dirs, filenames in os.walk(src_path):
                dirs[:] = [d for d in dirs if d not in {"_next", ".git", "__pycache__", "node_modules"}]
                for fname in filenames:
                    p = Path(root) / fname
                    files.append(p)
        else:
            for item in src_path.iterdir():
                if item.is_file() or item.is_symlink():
                    # Follow symlinks
                    if item.is_symlink():
                        real = item.resolve()
                        if real.exists():
                            files.append(item)
                    else:
                        files.append(item)

        print(f"  {cat:20s} ({mtype:5s}) -> {len(files):>6d} files")
        for f in files:
            all_files.append((cat, mtype, f))

    return all_files


def classify_file(filepath: Path) -> str | None:
    ext = filepath.suffix.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    return None


def main():
    print("=" * 70)
    print("  ASSET ORGANIZER v2 - ADDITIONAL SOURCES")
    print("=" * 70)

    t0 = time.time()

    # ---- Phase 1: Existing index ----
    existing_md5s = scan_existing()

    # ---- Phase 2: Scan new sources ----
    all_files = scan_new_sources()
    total_scanned = len(all_files)
    print(f"\n  Total new files: {total_scanned}")

    # Classify
    classified = []
    for cat, declared_type, filepath in all_files:
        actual_type = classify_file(filepath)
        if actual_type is None:
            continue  # skip non-media files
        if declared_type in ("video", "image"):
            classified.append((cat, declared_type, filepath))
        else:
            classified.append((cat, actual_type, filepath))

    img_count = sum(1 for _, t, _ in classified if t == "image")
    vid_count = sum(1 for _, t, _ in classified if t == "video")
    print(f"  Classified: {len(classified)} ({img_count} images, {vid_count} videos)")

    # ---- Phase 3: Compute MD5s for new files ----
    print(f"\n[PHASE 3] Computing MD5 hashes for new files ({MD5_WORKERS} workers)...")
    new_hashes = {}  # md5 -> (cat, type, filepath)
    cross_dupes = []  # duped with existing
    internal_dupes = []  # duped within new batch

    done = 0
    with ProcessPoolExecutor(max_workers=MD5_WORKERS) as pool:
        futures = {}
        for cat, ftype, fp in classified:
            futures[pool.submit(md5_file_standalone, str(fp))] = (cat, ftype, fp)

        for future in as_completed(futures):
            h, fp_str = future.result()
            cat, ftype, fp = futures[future]
            done += 1

            if done % 2000 == 0:
                print(f"  ... {done}/{len(classified)} hashed")

            if h is None:
                continue

            if h in existing_md5s:
                # Duplicate of an already-organized file
                cross_dupes.append((cat, ftype, fp, h))
            elif h in new_hashes:
                # Internal duplicate
                internal_dupes.append((cat, ftype, fp, h, new_hashes[h][2]))
            else:
                new_hashes[h] = (cat, ftype, fp)

    unique_new = list(new_hashes.values())
    print(f"\n  Unique new files: {len(unique_new)}")
    print(f"  Cross-deduped (already in organized): {len(cross_dupes)}")
    print(f"  Internal duplicates: {len(internal_dupes)}")

    # ---- Phase 4: Symlink unique new files ----
    print(f"\n[PHASE 4] Creating symlinks for new unique files...")

    created = {"images": 0, "videos": 0}
    errors = []

    for cat, ftype, filepath in unique_new:
        out_dir = OUTPUT_ROOT / ("images" if ftype == "image" else "videos")
        cat_dir = out_dir / cat
        cat_dir.mkdir(parents=True, exist_ok=True)

        # Use the file's own name; handle collisions with md5 suffix
        link_path = cat_dir / filepath.name
        if link_path.exists() or link_path.is_symlink():
            stem = filepath.stem
            suffix = filepath.suffix
            link_path = cat_dir / f"{stem}_{hashlib.md5(str(filepath).encode()).hexdigest()[:8]}{suffix}"

        try:
            # For symlinks, resolve to the actual file
            target = filepath.resolve() if filepath.is_symlink() else filepath
            os.symlink(target, link_path)
            created[ftype + "s"] += 1
        except Exception as e:
            errors.append({"file": str(filepath), "error": str(e)})

    print(f"  Images linked: {created['images']}")
    print(f"  Videos linked: {created['videos']}")

    # ---- Phase 5: Extract 4s frames from adult_content_videos ----
    print(f"\n[PHASE 5] Extracting {FRAME_AT_SEC}s frames from spicy_adult videos...")

    # Get the linked spicy_adult videos
    spicy_video_dir = OUTPUT_ROOT / "videos" / "spicy_adult"
    frame_output_dir = OUTPUT_ROOT / "images" / "spicy_frames_4s"
    frame_output_dir.mkdir(parents=True, exist_ok=True)

    video_links = []
    if spicy_video_dir.exists():
        for f in spicy_video_dir.iterdir():
            if f.is_symlink() and f.resolve().exists():
                video_links.append(f)
    print(f"  Videos to extract frames from: {len(video_links)}")

    frame_tasks = []
    for vlink in sorted(video_links):
        frame_name = vlink.stem + ".png"
        frame_path = frame_output_dir / frame_name
        if frame_path.exists():
            continue
        real_path = vlink.resolve()
        frame_tasks.append((real_path, frame_path))

    print(f"  Frames to extract: {len(frame_tasks)}")

    frame_ok = 0
    frame_fail = 0
    frame_errors = []
    done = 0

    with ProcessPoolExecutor(max_workers=FRAME_WORKERS) as pool:
        futures = {pool.submit(extract_frame, t): t for t in frame_tasks}
        for future in as_completed(futures):
            src, success, msg = future.result()
            done += 1
            if success:
                frame_ok += 1
            else:
                frame_fail += 1
                frame_errors.append((src, msg))

            if done % 1000 == 0 or done == len(frame_tasks):
                rate = done / (time.time() - t0) if time.time() > t0 else 0
                print(f"  [{done}/{len(frame_tasks)}] ok={frame_ok} fail={frame_fail} ({rate:.0f}/s)")

    created["frames"] = frame_ok
    print(f"  Frames extracted: {frame_ok}, failed: {frame_fail}")

    # ---- Summary ----
    elapsed = time.time() - t0
    print(f"\n{'=' * 70}")
    print(f"  DONE in {elapsed:.1f}s")
    print(f"  New unique assets linked: {created['images']} images + {created['videos']} videos")
    print(f"  4s frames extracted: {created['frames']}")
    print(f"  Cross-dupes (already existed): {len(cross_dupes)}")
    print(f"  Internal dupes: {len(internal_dupes)}")
    print(f"  Errors: {len(errors)} symlink, {len(frame_errors)} frame")
    print(f"{'=' * 70}")

    # Cross-dupe breakdown by category
    dup_by_cat = defaultdict(int)
    for cat, _, _, _ in cross_dupes:
        dup_by_cat[cat] += 1
    for cat, _, _, _ in internal_dupes:
        dup_by_cat[cat] += 1
    if dup_by_cat:
        print(f"\n  Duplicate breakdown:")
        for cat, count in sorted(dup_by_cat.items(), key=lambda x: -x[1]):
            print(f"    {cat}: {count} dupes")


if __name__ == "__main__":
    main()
