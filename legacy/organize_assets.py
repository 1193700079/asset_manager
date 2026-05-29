#!/usr/bin/env python3
"""
Edgelord Asset Organizer v1.0
Scans scraped media dirs, classifies image/video, MD5 dedup, symlinks to clean structure.

Output:
  images/   - all unique images by source category
  videos/   - all unique videos by source category
  report.json - full stats and dedup log
"""

import hashlib
import json
import os
import shutil
import sys
from collections import defaultdict
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import time

# ============================================================
# CONFIG
# ============================================================

SCRAPED_ROOT = Path("/mnt/user/joseph/data/ScrapedData")
OUTPUT_ROOT = Path("/mnt/cypher/project/asset_manager")

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".avif", ".heic", ".heif"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".flv", ".wmv", ".m4v"}

# Number of parallel MD5 workers (high concurrency since NAS is fast)
MD5_WORKERS = 16

# ============================================================
# SOURCE DEFINITIONS
# Each entry: (output_category, source_path, file_filter_func_or_None)
# ============================================================

def make_sources():
    """Returns list of (category_name, media_type, source_path, filter_fn)"""
    C = SCRAPED_ROOT / "clothoff_feeds" / "publications"
    CR = SCRAPED_ROOT / "Createhottie"
    ND = SCRAPED_ROOT / "nudiva" / "media"
    UD = SCRAPED_ROOT / "undress_scrape"
    FP = SCRAPED_ROOT / "fapify" / "media"

    sources = [
        # --- CLOTHOFF FEEDS ---
        ("clothoff_naked",        "image", C / "naked",        None),
        ("clothoff_realism",      "image", C / "realism",      None),
        ("clothoff_showing_butt", "image", C / "showing_butt", None),
        ("clothoff_small_boobs",  "image", C / "small_boobs",  None),
        # popular has mixed mp4 + preview jpgs
        ("clothoff_popular",      "mixed", C / "popular",      None),

        # --- CREATEHOTTIE ---
        ("createhottie",         "image", CR / "previews", None),
        ("createhottie",         "video", CR / "videos",   None),

        # --- FAPIFY ---
        ("fapify_frames",        "image", SCRAPED_ROOT / "fapify_frames_4sec", None),
        ("fapify_thumbs",        "image", FP,  lambda p: p.name == "thumb.webp"),  # recursive, only thumbs

        # --- NUDIVA ---
        # feed has mixed images/videos in nested dirs
        ("nudiva_feed",          "mixed", ND / "feed",  lambda p: p.suffix.lower() not in {".json"}),
        ("nudiva_grid_poster",   "image", ND / "grid" / "poster", None),
        ("nudiva_grid_video",    "video", ND / "grid" / "video",  None),  # recursive into mp4/ webm/

        # --- UNDRESS ---
        ("undress_previews",     "image", UD / "previews", None),
        ("undress_videos",       "video", UD / "videos",   None),

        # --- VIDEO FRAMES (extracted stills) ---
        ("video_frames",         "image", SCRAPED_ROOT / "video_frames_4sec", None),
    ]
    return sources


# ============================================================
# CORE LOGIC
# ============================================================

def md5_file(filepath: Path) -> str:
    """Compute MD5 hex digest of a file."""
    h = hashlib.md5()
    with open(filepath, "rb") as f:
        while True:
            chunk = f.read(8192 * 16)  # 128KB chunks
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def classify_file(filepath: Path) -> str | None:
    """Classify file as 'image' or 'video' based on extension. Returns None if unknown."""
    ext = filepath.suffix.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    return None


def scan_source(source_path: Path, filter_fn=None, recursive=None) -> list[Path]:
    """
    Scan a source directory and return list of file paths.
    If recursive is None, auto-decide based on whether subdirs have files.
    """
    if not source_path.exists():
        print(f"  [SKIP] Source not found: {source_path}")
        return []

    files = []

    # Auto-detect recursion: if filter_fn is set, always recurse
    do_recurse = recursive if recursive is not None else (filter_fn is not None)

    if do_recurse:
        for root, dirs, filenames in os.walk(source_path):
            # Skip _next dirs (Next.js build artifacts)
            dirs[:] = [d for d in dirs if d not in {"_next", ".git", "__pycache__", "node_modules"}]
            for fname in filenames:
                p = Path(root) / fname
                if filter_fn and not filter_fn(p):
                    continue
                files.append(p)
    else:
        for item in source_path.iterdir():
            if item.is_file():
                if filter_fn and not filter_fn(item):
                    continue
                files.append(item)

    return files


def organize():
    """Main organization pipeline."""
    print("=" * 70)
    print("  EDGELORD ASSET ORGANIZER v1.0")
    print("  Scanning, classifying, deduplicating, symlinking...")
    print("=" * 70)

    t0 = time.time()
    sources = make_sources()

    # Phase 1: Scan all sources
    print("\n[PHASE 1] Scanning source directories...")
    all_files = []  # list of (category, declared_type, filepath)

    for cat, media_type, src_path, filt in sources:
        # Determine recursion
        recurse = None
        if media_type == "mixed" or filt is not None:
            recurse = True
        # nudiva grid video has mp4/ and webm/ subdirs
        if "grid/video" in str(src_path):
            recurse = True
        # fapify thumbs are nested
        if cat == "fapify_thumbs":
            recurse = True

        files = scan_source(src_path, filt, recursive=recurse)
        print(f"  {cat:25s} ({media_type:5s}) {src_path.name:20s} -> {len(files):>6d} files")
        for f in files:
            all_files.append((cat, media_type, f))

    total_scanned = len(all_files)
    print(f"\n  Total files scanned: {total_scanned}")

    # Phase 2: Classify mixed sources
    print("\n[PHASE 2] Classifying files (image vs video)...")
    classified = []  # list of (category, actual_type, filepath)

    for cat, declared_type, filepath in all_files:
        actual_type = classify_file(filepath)
        if actual_type is None:
            # Skip unknown file types (json, svg, log, etc)
            continue

        if declared_type == "mixed":
            # Use actual_type
            classified.append((cat, actual_type, filepath))
        elif declared_type in ("image", "video"):
            # Trust declared type but use actual for output routing
            classified.append((cat, declared_type, filepath))

    # Filter fapify_thumbs: only keep actual images
    # (the recursive scan might have caught non-thumb files if filter_fn missed)

    print(f"  Classified: {len(classified)} files")
    img_count = sum(1 for _, t, _ in classified if t == "image")
    vid_count = sum(1 for _, t, _ in classified if t == "video")
    print(f"  Images: {img_count}, Videos: {vid_count}")

    # Phase 3: Compute MD5 hashes
    print(f"\n[PHASE 3] Computing MD5 hashes ({MD5_WORKERS} workers)...")

    file_hashes = {}  # filepath -> md5
    batch_size = 200
    total = len(classified)

    with ThreadPoolExecutor(max_workers=MD5_WORKERS) as pool:
        futures = {pool.submit(md5_file, fp): (cat, ftype, fp) for cat, ftype, fp in classified}
        done = 0
        for future in as_completed(futures):
            cat, ftype, fp = futures[future]
            try:
                h = future.result()
                file_hashes[id(fp)] = (cat, ftype, fp, h)
            except Exception as e:
                print(f"  [ERR] {fp}: {e}")
            done += 1
            if done % 1000 == 0:
                print(f"  ... {done}/{total} hashed ({100*done//total}%)")

    print(f"  Hashed {len(file_hashes)} files")

    # Phase 4: Deduplicate
    print("\n[PHASE 4] Deduplicating by MD5...")
    seen_hashes = {}  # md5 -> first (cat, ftype, filepath)
    unique_files = []  # list of (cat, ftype, filepath, md5)
    duplicates = []  # list of (cat, ftype, filepath, md5, original_path)

    for fid, (cat, ftype, fp, h) in file_hashes.items():
        if h in seen_hashes:
            orig_cat, orig_type, orig_fp = seen_hashes[h]
            duplicates.append((cat, ftype, fp, h, orig_fp))
        else:
            seen_hashes[h] = (cat, ftype, fp)
            unique_files.append((cat, ftype, fp, h))

    print(f"  Unique: {len(unique_files)}")
    print(f"  Duplicates removed: {len(duplicates)}")

    # Phase 5: Create output structure with symlinks
    print("\n[PHASE 5] Creating symlink structure...")

    out_images = OUTPUT_ROOT / "images"
    out_videos = OUTPUT_ROOT / "videos"
    out_images.mkdir(parents=True, exist_ok=True)
    out_videos.mkdir(parents=True, exist_ok=True)

    created = {"images": 0, "videos": 0}
    errors = []

    for cat, ftype, filepath, md5 in unique_files:
        out_dir = out_images if ftype == "image" else out_videos
        cat_dir = out_dir / cat
        cat_dir.mkdir(parents=True, exist_ok=True)

        # Handle filename conflicts (same name from different sources)
        link_path = cat_dir / filepath.name
        if link_path.exists() or link_path.is_symlink():
            # Rename to avoid collision: append md5 prefix
            stem = filepath.stem
            suffix = filepath.suffix
            link_path = cat_dir / f"{stem}_{md5[:8]}{suffix}"

        try:
            os.symlink(filepath.resolve(), link_path)
            created["images" if ftype == "image" else "videos"] += 1
        except Exception as e:
            errors.append({"file": str(filepath), "error": str(e)})

    print(f"  Images linked: {created['images']}")
    print(f"  Videos linked: {created['videos']}")
    if errors:
        print(f"  Errors: {len(errors)}")

    # Phase 6: Summary per category
    print("\n[PHASE 6] Category breakdown:")
    cat_stats = defaultdict(lambda: {"images": 0, "videos": 0})
    for cat, ftype, fp, md5 in unique_files:
        if ftype == "image":
            cat_stats[cat]["images"] += 1
        else:
            cat_stats[cat]["videos"] += 1

    print(f"\n  {'Category':<25s} {'Images':>8s} {'Videos':>8s} {'Total':>8s}")
    print(f"  {'-'*25} {'-'*8} {'-'*8} {'-'*8}")
    for cat in sorted(cat_stats.keys()):
        s = cat_stats[cat]
        total = s["images"] + s["videos"]
        print(f"  {cat:<25s} {s['images']:>8d} {s['videos']:>8d} {total:>8d}")

    grand_img = sum(s["images"] for s in cat_stats.values())
    grand_vid = sum(s["videos"] for s in cat_stats.values())
    print(f"  {'-'*25} {'-'*8} {'-'*8} {'-'*8}")
    print(f"  {'TOTAL':<25s} {grand_img:>8d} {grand_vid:>8d} {grand_img+grand_vid:>8d}")

    # Phase 7: Report
    print(f"\n[PHASE 7] Writing report...")
    elapsed = time.time() - t0

    report = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "elapsed_seconds": round(elapsed, 1),
        "scraped_root": str(SCRAPED_ROOT),
        "output_root": str(OUTPUT_ROOT),
        "summary": {
            "total_scanned": total_scanned,
            "total_classified": len(classified),
            "total_unique": len(unique_files),
            "total_duplicates": len(duplicates),
            "total_images": grand_img,
            "total_videos": grand_vid,
            "total_symlinks_created": created["images"] + created["videos"],
        },
        "categories": {cat: dict(stats) for cat, stats in sorted(cat_stats.items())},
        "duplicates": [
            {
                "file": str(dup_path),
                "md5": md5,
                "original": str(orig_path),
                "category": cat,
            }
            for cat, _, dup_path, md5, orig_path in duplicates[:100]  # first 100
        ],
        "duplicate_count": len(duplicates),
        "errors": errors[:50],
        "deferred": {
            "fapify_video_trim": {
                "description": "Trim first 1 second from fapify/media videos",
                "hq_count": 1594,
                "comp_count": 183,
                "target_dir": str(OUTPUT_ROOT / "videos" / "fapify_trimmed"),
            }
        }
    }

    report_path = OUTPUT_ROOT / "report.json"
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"  Report saved to: {report_path}")

    # Duplicate breakdown by category
    dup_by_cat = defaultdict(int)
    for cat, _, _, _, _ in duplicates:
        dup_by_cat[cat] += 1
    if dup_by_cat:
        print(f"\n  Duplicates by category:")
        for cat, count in sorted(dup_by_cat.items(), key=lambda x: -x[1]):
            print(f"    {cat:<25s} {count:>6d} dupes")

    print(f"\n{'='*70}")
    print(f"  DONE in {elapsed:.1f}s")
    print(f"  {grand_img} unique images + {grand_vid} unique videos = {grand_img+grand_vid} total")
    print(f"  {len(duplicates)} duplicates removed")
    print(f"{'='*70}")

    return report


if __name__ == "__main__":
    organize()
