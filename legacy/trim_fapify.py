#!/usr/bin/env python3
"""
Fapify Video Trimmer v1.0
Cuts first 1 second from all fapify hq/comp videos via ffmpeg.
Parallel processing with 64 workers (128 cores available).

Usage: python3 trim_fapify.py [--workers N] [--dry-run] [--overwrite]
"""

import argparse
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

MEDIA_ROOT = Path("/mnt/user/joseph/data/ScrapedData/fapify/media")
OUTPUT_ROOT = Path("/mnt/cypher/project/asset_manager/videos/fapify_trimmed")
DEFAULT_WORKERS = 64
TRIM_SECONDS = 1.0


def collect_videos():
    """Find all hq and comp videos."""
    videos = []
    if not MEDIA_ROOT.exists():
        print(f"[ERROR] Media root not found: {MEDIA_ROOT}")
        return videos

    for item in sorted(MEDIA_ROOT.iterdir()):
        if not item.is_dir():
            continue
        parent_name = item.name  # e.g. 69e233e795048f9e89e16e91_Both_Balls_Engulfed

        hq = item / "video_hq.mp4"
        comp = item / "video_comp.mp4"

        if hq.exists():
            videos.append(("hq", parent_name, hq))
        if comp.exists():
            videos.append(("comp", parent_name, comp))

    return videos


def trim_video(args):
    """Trim a single video. Returns (quality, name, src, success, msg, elapsed)."""
    quality, name, src, overwrite = args

    out_dir = OUTPUT_ROOT / quality
    out_dir.mkdir(parents=True, exist_ok=True)
    dst = out_dir / f"{name}.mp4"

    if dst.exists() and not overwrite:
        return (quality, name, str(src), True, "skipped (exists)", 0)

    # Always re-encode: stream copy is NOT frame-accurate due to sparse keyframes
    # (these web videos have only ~3 keyframes per 8s, causing massive content loss)
    # Input-side -ss for fast seeking + re-encode for frame-accurate trim
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(TRIM_SECONDS),
        "-i", str(src),
        "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        str(dst),
    ]

    t0 = time.time()
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,
        )
        elapsed = time.time() - t0

        if result.returncode != 0:
            return (quality, name, str(src), False,
                    result.stderr[-200:] if result.stderr else "unknown error", elapsed)

        # Verify output file
        if not dst.exists() or dst.stat().st_size < 1024:
            return (quality, name, str(src), False, f"output too small ({dst.stat().st_size}b)", elapsed)

        return (quality, name, str(src), True, "ok", elapsed)

    except subprocess.TimeoutExpired:
        return (quality, name, str(src), False, "timeout", time.time() - t0)
    except Exception as e:
        return (quality, name, str(src), False, str(e), time.time() - t0)


def main():
    parser = argparse.ArgumentParser(description="Trim first 1s from fapify videos")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS,
                        help=f"Parallel workers (default: {DEFAULT_WORKERS})")
    parser.add_argument("--dry-run", action="store_true", help="Just count, don't process")
    parser.add_argument("--overwrite", action="store_true", help="Re-process existing files")
    parser.add_argument("--quality", choices=["hq", "comp", "all"], default="all",
                        help="Process only hq, comp, or all (default: all)")
    args = parser.parse_args()

    print("=" * 60)
    print("  FAPIFY VIDEO TRIMMER")
    print(f"  Trim: first {TRIM_SECONDS}s | Workers: {args.workers}")
    print("=" * 60)

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

    # Collect
    all_videos = collect_videos()
    if args.quality != "all":
        all_videos = [v for v in all_videos if v[0] == args.quality]

    hq_count = sum(1 for q, _, _ in all_videos if q == "hq")
    comp_count = sum(1 for q, _, _ in all_videos if q == "comp")
    print(f"\n  Found: {hq_count} HQ + {comp_count} comp = {len(all_videos)} total")

    if args.dry_run:
        print("  [DRY RUN] No processing.")
        return

    # Process
    t0 = time.time()
    work_items = [(q, n, s, args.overwrite) for q, n, s in all_videos]
    done = 0
    ok = 0
    fail = 0
    skip = 0
    errors = []
    total = len(work_items)

    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(trim_video, w): w for w in work_items}

        for future in as_completed(futures):
            quality, name, src, success, msg, elapsed = future.result()
            done += 1

            if success:
                if "skipped" in msg:
                    skip += 1
                else:
                    ok += 1
            else:
                fail += 1
                errors.append({"file": src, "error": msg})

            if done % 100 == 0 or done == total:
                rate = done / (time.time() - t0) if time.time() > t0 else 0
                eta = (total - done) / rate if rate > 0 else 0
                print(f"  [{done:>5d}/{total}] ok={ok} skip={skip} fail={fail} "
                      f"({rate:.0f}/s, ETA {eta:.0f}s)")

    elapsed = time.time() - t0
    print(f"\n{'=' * 60}")
    print(f"  DONE in {elapsed:.1f}s")
    print(f"  Processed: {ok} | Skipped: {skip} | Failed: {fail}")
    if errors:
        print(f"\n  Failed files:")
        for e in errors[:20]:
            print(f"    {e['file']}")
            print(f"      -> {e['error']}")
    print(f"{'=' * 60}")

    # Verify output
    print(f"\n  Output directory: {OUTPUT_ROOT}")
    for q in ["hq", "comp"]:
        qdir = OUTPUT_ROOT / q
        if qdir.exists():
            count = len(list(qdir.glob("*.mp4")))
            print(f"    {q}/: {count} files")


if __name__ == "__main__":
    main()
