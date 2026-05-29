#!/usr/bin/env python3
"""
Fix the 198 files where -c copy produced empty 262b outputs.
Reprocess them with re-encode (libx264 + aac).
"""

import os
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

MEDIA_ROOT = Path("/mnt/user/joseph/data/ScrapedData/fapify/media")
OUTPUT_ROOT = Path("/mnt/cypher/project/asset_manager/videos/fapify_trimmed")

def find_broken():
    """Find all output mp4s under 1KB and map back to source."""
    broken = []
    for quality in ["hq", "comp"]:
        out_dir = OUTPUT_ROOT / quality
        src_name = "video_hq.mp4" if quality == "hq" else "video_comp.mp4"
        if not out_dir.exists():
            continue
        for f in out_dir.glob("*.mp4"):
            if f.stat().st_size < 1024:
                name = f.stem
                src = MEDIA_ROOT / name / src_name
                if src.exists():
                    broken.append((quality, name, src, f))
    return broken

def reencode(args):
    quality, name, src, dst = args
    cmd = [
        "ffmpeg", "-y",
        "-ss", "1",   # input-side seek for speed
        "-i", str(src),
        "-c:v", "libx264", "-crf", "18", "-preset", "fast",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        str(dst),
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            return (name, False, r.stderr[-150:])
        if dst.stat().st_size < 1024:
            return (name, False, "still tiny after reencode")
        return (name, True, f"{dst.stat().st_size // 1024}KB")
    except Exception as e:
        return (name, False, str(e))

def main():
    broken = find_broken()
    print(f"Found {len(broken)} broken files to reprocess")

    work = [(q, n, s, d) for q, n, s, d in broken]
    ok = 0
    fail = 0
    errors = []

    with ProcessPoolExecutor(max_workers=32) as pool:
        futures = {pool.submit(reencode, w): w for w in work}
        for future in as_completed(futures):
            name, success, msg = future.result()
            if success:
                ok += 1
            else:
                fail += 1
                errors.append((name, msg))
            if (ok + fail) % 20 == 0:
                print(f"  [{ok + fail}/{len(work)}] ok={ok} fail={fail}")

    print(f"\nDone: {ok} fixed, {fail} still broken")
    if errors:
        print("Still broken:")
        for n, e in errors[:10]:
            print(f"  {n}: {e}")

if __name__ == "__main__":
    main()
