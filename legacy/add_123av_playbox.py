#!/usr/bin/env python3
"""
Quick add: 123av_output + playbox_output/images
Cross-dedup against ALL existing organized assets.
"""
import hashlib, os, sys, time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from collections import defaultdict

OUTPUT_ROOT = Path("/mnt/cypher/project/asset_manager")
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".avif", ".heic", ".heif"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".avi", ".mkv"}
MD5_WORKERS = 32

def md5_of(path_str):
    h = hashlib.md5()
    try:
        with open(path_str, "rb") as f:
            while True:
                chunk = f.read(131072)
                if not chunk: break
                h.update(chunk)
        return (h.hexdigest(), path_str)
    except:
        return (None, path_str)

def main():
    print("=" * 60)
    print("  QUICK ADD: 123av + playbox_images")
    print("=" * 60)
    t0 = time.time()

    # Phase 1: Build existing MD5 index
    print("\n[1] Indexing existing asset MD5s...")
    existing = []
    for sub in ["images", "videos"]:
        base = OUTPUT_ROOT / sub
        if not base.exists(): continue
        for cat in base.iterdir():
            if not cat.is_dir(): continue
            if cat.name == "fapify_trimmed": continue
            for f in cat.iterdir():
                if f.is_symlink():
                    real = f.resolve()
                    if real.exists():
                        existing.append(str(real))

    existing_md5s = set()
    with ProcessPoolExecutor(max_workers=MD5_WORKERS) as pool:
        futs = {pool.submit(md5_of, p): p for p in existing}
        done = 0
        for fut in as_completed(futs):
            h, _ = fut.result()
            if h: existing_md5s.add(h)
            done += 1
            if done % 5000 == 0:
                print(f"  ... {done}/{len(existing)}")
    print(f"  Existing unique hashes: {len(existing_md5s)}")

    # Phase 2: Collect new files
    print("\n[2] Scanning new sources...")
    new_files = []  # (category, media_type, filepath)

    # 123av
    av_posters = Path("/mnt/cypher/project/crawel/123av_output/posters")
    av_videos = Path("/mnt/cypher/project/crawel/123av_output/videos")
    if av_posters.exists():
        c = 0
        for f in av_posters.iterdir():
            if f.is_file() and f.suffix.lower() in IMAGE_EXTS:
                new_files.append(("123av_poster", "image", f))
                c += 1
        print(f"  123av_poster (image): {c}")

    if av_videos.exists():
        c = 0
        for f in av_videos.iterdir():
            if f.is_file() and f.suffix.lower() in VIDEO_EXTS:
                new_files.append(("123av_video", "video", f))
                c += 1
        print(f"  123av_video (video): {c}")

    # playbox images
    pbox = Path("/mnt/cypher/project/crawel/playbox_output/images")
    if pbox.exists():
        c = 0
        for f in pbox.iterdir():
            if f.is_file() and f.suffix.lower() in IMAGE_EXTS:
                new_files.append(("playbox_images", "image", f))
                c += 1
        print(f"  playbox_images (image): {c}")

    print(f"\n  Total new: {len(new_files)}")

    # Phase 3: MD5 + dedup
    print(f"\n[3] Hashing {len(new_files)} files ({MD5_WORKERS} workers)...")
    unique = []
    cross_dupes = 0
    internal_dupes = 0
    seen = {}

    with ProcessPoolExecutor(max_workers=MD5_WORKERS) as pool:
        futs = {pool.submit(md5_of, str(fp)): (cat, mtype, fp) for cat, mtype, fp in new_files}
        done = 0
        for fut in as_completed(futs):
            h, _ = fut.result()
            cat, mtype, fp = futs[fut]
            done += 1
            if done % 2000 == 0:
                print(f"  ... {done}/{len(new_files)}")
            if h is None: continue
            if h in existing_md5s:
                cross_dupes += 1
            elif h in seen:
                internal_dupes += 1
            else:
                seen[h] = True
                unique.append((cat, mtype, fp))

    print(f"\n  Unique new: {len(unique)}")
    print(f"  Cross-duped (existing): {cross_dupes}")
    print(f"  Internal dupes: {internal_dupes}")

    # Phase 4: Symlink
    print(f"\n[4] Creating symlinks...")
    created = {"image": 0, "video": 0}
    for cat, mtype, fp in unique:
        out_dir = OUTPUT_ROOT / ("images" if mtype == "image" else "videos") / cat
        out_dir.mkdir(parents=True, exist_ok=True)
        link = out_dir / fp.name
        if link.exists() or link.is_symlink():
            stem, ext = fp.stem, fp.suffix
            link = out_dir / f"{stem}_{hashlib.md5(str(fp).encode()).hexdigest()[:8]}{ext}"
        try:
            os.symlink(fp.resolve(), link)
            created[mtype] += 1
        except Exception as e:
            pass

    elapsed = time.time() - t0
    print(f"\n{'=' * 60}")
    print(f"  DONE in {elapsed:.1f}s")
    print(f"  Images added: {created['image']}")
    print(f"  Videos added: {created['video']}")
    print(f"  Total added:  {created['image'] + created['video']}")
    print(f"  Deduped: {cross_dupes + internal_dupes}")
    print(f"{'=' * 60}")

if __name__ == "__main__":
    main()
