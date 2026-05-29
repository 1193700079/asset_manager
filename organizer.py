#!/usr/bin/env python3
"""
Asset Organizer - Unified with SQLite Hash Cache
=================================================
One script to rule them all. Persistent MD5 cache means only NEW/CHANGED
files get hashed on subsequent runs.

Usage:
  python3 organizer.py add <name> <path> [--type image|video|auto] [--recursive]
  python3 organizer.py scan                      # re-scan all registered sources
  python3 organizer.py status                    # show DB stats & current totals
  python3 organizer.py extract-frames <video_cat> [--at 4.0]  # extract frames from a video category
  python3 organizer.py list-sources              # list registered sources

Examples:
  python3 organizer.py add spicy_new /data/new_stuff --type video
  python3 organizer.py add photos /data/pics --type image --recursive
  python3 organizer.py add mixed /data/mixed --type auto --recursive
  python3 organizer.py extract-frames spicy_adult --at 4
"""

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

# ============================================================
# CONFIG
# ============================================================

OUTPUT_ROOT = Path("/mnt/cypher/project/asset_manager")
DB_PATH = OUTPUT_ROOT / "hash_cache.db"
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".avif", ".heic", ".heif"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".flv", ".wmv", ".m4v"}
ALL_MEDIA = IMAGE_EXTS | VIDEO_EXTS
HASH_WORKERS = 32
FRAME_WORKERS = 24
HASH_CHUNK = 131072  # 128KB read chunks


# ============================================================
# SQLITE CACHE
# ============================================================

def init_db():
    """Create tables if not exist."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS file_hashes (
            filepath    TEXT PRIMARY KEY,
            size        INTEGER NOT NULL,
            mtime       REAL NOT NULL,
            md5         TEXT NOT NULL,
            media_type  TEXT NOT NULL,  -- 'image' or 'video'
            category    TEXT NOT NULL,
            scan_time   REAL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sources (
            name        TEXT PRIMARY KEY,
            path        TEXT NOT NULL,
            media_type  TEXT NOT NULL,  -- 'image', 'video', or 'auto'
            recursive   INTEGER NOT NULL DEFAULT 0,
            registered  REAL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_md5 ON file_hashes(md5)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_category ON file_hashes(category)")
    conn.commit()
    return conn


def get_all_known_hashes(conn) -> dict[str, dict]:
    """Load all cached hashes into memory. Returns {md5: {filepath, size, mtime, media_type, category}}."""
    cursor = conn.execute("SELECT md5, filepath, size, mtime, media_type, category FROM file_hashes")
    result = {}
    for md5, fp, size, mtime, mtype, cat in cursor:
        result[md5] = {
            "filepath": fp, "size": size, "mtime": mtime,
            "media_type": mtype, "category": cat,
        }
    return result


def get_all_filepath_hashes(conn) -> set[str]:
    """Get set of all known file paths."""
    cursor = conn.execute("SELECT filepath FROM file_hashes")
    return {row[0] for row in cursor}


# ============================================================
# HASHING (multiprocess)
# ============================================================

def hash_files_batch(file_list: list[str]) -> list[tuple]:
    """
    Hash a list of files. Called in worker processes.
    Returns list of (filepath, md5_or_None, size, mtime).
    """
    results = []
    for fp in file_list:
        h = hashlib.md5()
        try:
            st = os.stat(fp)
            with open(fp, "rb") as f:
                while True:
                    chunk = f.read(HASH_CHUNK)
                    if not chunk:
                        break
                    h.update(chunk)
            results.append((fp, h.hexdigest(), st.st_size, st.st_mtime))
        except Exception:
            results.append((fp, None, 0, 0))
    return results


def hash_single(args):
    """Hash a single file. For ProcessPoolExecutor."""
    fp = args
    h = hashlib.md5()
    try:
        resolved = os.path.realpath(fp)
        st = os.stat(resolved)
        with open(resolved, "rb") as f:
            while True:
                chunk = f.read(HASH_CHUNK)
                if not chunk:
                    break
                h.update(chunk)
        return (fp, h.hexdigest(), st.st_size, st.st_mtime)
    except Exception:
        return (fp, None, 0, 0)


# ============================================================
# FILE SCANNING
# ============================================================

def classify_file(filepath: Path) -> str | None:
    ext = filepath.suffix.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    return None


def scan_directory(src_path: Path, recursive: bool = False) -> list[Path]:
    """Scan a directory for media files."""
    if not src_path.exists():
        return []

    files = []
    if recursive:
        for root, dirs, filenames in os.walk(src_path):
            dirs[:] = [d for d in dirs if d not in {"_next", ".git", "__pycache__", "node_modules"}]
            for fname in filenames:
                p = Path(root) / fname
                if p.suffix.lower() in ALL_MEDIA:
                    files.append(p)
    else:
        for item in src_path.iterdir():
            if (item.is_file() or item.is_symlink()) and item.suffix.lower() in ALL_MEDIA:
                if item.is_symlink():
                    if item.resolve().exists():
                        files.append(item)
                else:
                    files.append(item)
    return files


# ============================================================
# CORE: ADD SOURCE
# ============================================================

def cmd_add(conn, args):
    """Add a new source: scan, hash (cached), dedup, symlink."""
    name = args.name
    src_path = Path(args.path).resolve()
    media_type = args.type  # 'image', 'video', or 'auto'
    recursive = args.recursive

    if not src_path.exists():
        print(f"[ERROR] Path not found: {src_path}")
        return

    # Register source
    conn.execute(
        "INSERT OR REPLACE INTO sources (name, path, media_type, recursive, registered) VALUES (?,?,?,?,?)",
        (name, str(src_path), media_type, int(recursive), time.time())
    )
    conn.commit()

    print("=" * 60)
    print(f"  ADD SOURCE: {name}")
    print(f"  Path: {src_path}")
    print(f"  Type: {media_type} | Recursive: {recursive}")
    print("=" * 60)

    t0 = time.time()

    # Step 1: Scan files
    print(f"\n[1] Scanning {src_path}...")
    files = scan_directory(src_path, recursive)
    print(f"    Found {len(files)} media files")
    if not files:
        print("    Nothing to do.")
        return

    # Step 2: Load known hashes from DB
    print(f"\n[2] Loading hash cache...")
    known_hashes = get_all_known_hashes(conn)
    known_md5_set = set(known_hashes.keys())
    print(f"    {len(known_hashes)} cached hashes loaded")

    # Step 3: Determine which files need hashing
    print(f"\n[3] Checking cache...")
    need_hash = []   # files that need MD5 computation
    cached_hits = 0
    new_files_list = []  # (filepath_str, declared_type)

    for f in files:
        fp_str = str(f.resolve())
        try:
            st = os.stat(fp_str)
        except OSError:
            continue

        ftype = media_type if media_type != "auto" else classify_file(f)
        if ftype is None:
            continue

        # Check cache: filepath exists AND size+mtime match
        cached = None
        cursor = conn.execute(
            "SELECT md5, size, mtime FROM file_hashes WHERE filepath=?", (fp_str,)
        )
        row = cursor.fetchone()
        if row and row[1] == st.st_size and abs(row[2] - st.st_mtime) < 0.01:
            # Cache hit - file unchanged
            cached_hits += 1
            cached = row[0]
            new_files_list.append((fp_str, ftype, cached))
        else:
            need_hash.append(fp_str)
            new_files_list.append((fp_str, ftype, None))

    print(f"    Cache hits: {cached_hits}")
    print(f"    Need hashing: {len(need_hash)}")

    # Step 4: Hash new/changed files
    print(f"\n[4] Hashing {len(need_hash)} files ({HASH_WORKERS} workers)...")
    hash_results = {}  # filepath -> (md5, size, mtime)

    if need_hash:
        with ProcessPoolExecutor(max_workers=HASH_WORKERS) as pool:
            futures = {pool.submit(hash_single, fp): fp for fp in need_hash}
            done = 0
            for future in as_completed(futures):
                fp, md5, size, mtime = future.result()
                done += 1
                if md5:
                    hash_results[fp] = (md5, size, mtime)
                if done % 2000 == 0:
                    print(f"      ... {done}/{len(need_hash)}")
        print(f"    Hashed {len(hash_results)} files")
    else:
        print("    No hashing needed!")

    # Step 5: Fill in cached hashes
    all_with_hash = {}  # filepath -> (md5, ftype)
    cache_writes = []
    for fp_str, ftype, cached_md5 in new_files_list:
        if cached_md5:
            all_with_hash[fp_str] = (cached_md5, ftype)
        elif fp_str in hash_results:
            md5, size, mtime = hash_results[fp_str]
            all_with_hash[fp_str] = (md5, ftype)
            cache_writes.append((fp_str, size, mtime, md5, ftype, name))

    # Step 6: Write new hashes to cache
    if cache_writes:
        print(f"\n[5] Updating hash cache ({len(cache_writes)} new entries)...")
        conn.executemany(
            "INSERT OR REPLACE INTO file_hashes (filepath, size, mtime, md5, media_type, category, scan_time) VALUES (?,?,?,?,?,?,?)",
            [(fp, sz, mt, md, mt2, cat, time.time()) for fp, sz, mt, md, mt2, cat in cache_writes]
        )
        conn.commit()
        print("    Done")

    # Step 7: Dedup against ALL known hashes (including just-added)
    print(f"\n[6] Deduplicating {len(all_with_hash)} files against global index...")
    unique_new = []  # (filepath, md5, ftype)
    dup_cross = 0
    dup_internal = 0

    seen_in_batch = set()
    for fp_str, (md5, ftype) in all_with_hash.items():
        if md5 in known_md5_set:
            # Already exists in DB (from a previous source)
            dup_cross += 1
        elif md5 in seen_in_batch:
            dup_internal += 1
        else:
            seen_in_batch.add(md5)
            unique_new.append((fp_str, md5, ftype))

    print(f"    Unique new: {len(unique_new)}")
    print(f"    Cross-duped (existing): {dup_cross}")
    print(f"    Internal dupes: {dup_internal}")

    # Step 8: Symlink
    print(f"\n[7] Creating symlinks...")
    created = {"image": 0, "video": 0}
    for fp_str, md5, ftype in unique_new:
        out_base = OUTPUT_ROOT / ("images" if ftype == "image" else "videos")
        cat_dir = out_base / name
        cat_dir.mkdir(parents=True, exist_ok=True)

        fp = Path(fp_str)
        link_path = cat_dir / fp.name
        if link_path.exists() or link_path.is_symlink():
            stem = fp.stem
            ext = fp.suffix
            link_path = cat_dir / f"{stem}_{md5[:8]}{ext}"

        try:
            os.symlink(fp, link_path)
            created[ftype] += 1
        except Exception:
            pass

    elapsed = time.time() - t0
    total_new = created["image"] + created["video"]
    print(f"\n{'=' * 60}")
    print(f"  DONE in {elapsed:.1f}s")
    print(f"  Images: {created['image']} | Videos: {created['video']} | Total: {total_new}")
    print(f"  Deduped: {dup_cross + dup_internal}")
    print(f"  Cache: {cached_hits} hits / {len(need_hash)} new hashes")
    print(f"{'=' * 60}")

    # Update the known set with new hashes for future cross-ref
    for fp_str, (md5, ftype) in all_with_hash.items():
        known_md5_set.add(md5)

    # Summary
    print_running_totals(conn)


# ============================================================
# CORE: RE-SCAN ALL SOURCES
# ============================================================

def cmd_scan(conn, args):
    """Re-scan all registered sources. Only hashes new/changed files."""
    print("=" * 60)
    print("  RE-SCAN ALL REGISTERED SOURCES")
    print("=" * 60)

    cursor = conn.execute("SELECT name, path, media_type, recursive FROM sources")
    sources = cursor.fetchall()
    if not sources:
        print("  No sources registered. Use 'add' first.")
        return

    t0 = time.time()

    # Load cache
    print(f"\n[1] Loading hash cache...")
    known_hashes = get_all_known_hashes(conn)
    known_md5_set = set(known_hashes.keys())
    old_count = len(known_md5_set)
    print(f"    {old_count} cached hashes")

    all_unique = []
    total_cache_hits = 0
    total_need_hash = 0
    total_cross_dup = 0
    total_internal_dup = 0

    for name, src_path_str, media_type, recursive in sources:
        src_path = Path(src_path_str)
        if not src_path.exists():
            print(f"\n  [SKIP] {name}: {src_path} not found")
            continue

        print(f"\n  --- {name} ({media_type}) ---")
        files = scan_directory(src_path, bool(recursive))
        print(f"    Files: {len(files)}")

        need_hash = []
        file_data = []  # (fp_str, ftype, cached_md5_or_None)

        for f in files:
            fp_str = str(f.resolve())
            try:
                st = os.stat(fp_str)
            except OSError:
                continue
            ftype = media_type if media_type != "auto" else classify_file(f)
            if ftype is None:
                continue

            row = conn.execute(
                "SELECT md5, size, mtime FROM file_hashes WHERE filepath=?", (fp_str,)
            ).fetchone()

            if row and row[1] == st.st_size and abs(row[2] - st.st_mtime) < 0.01:
                total_cache_hits += 1
                file_data.append((fp_str, ftype, row[0]))
            else:
                need_hash.append(fp_str)
                file_data.append((fp_str, ftype, None))

        total_need_hash += len(need_hash)

        # Hash new files
        hash_results = {}
        if need_hash:
            with ProcessPoolExecutor(max_workers=HASH_WORKERS) as pool:
                futs = {pool.submit(hash_single, fp): fp for fp in need_hash}
                for fut in as_completed(futs):
                    fp, md5, size, mtime = fut.result()
                    if md5:
                        hash_results[fp] = (md5, size, mtime)

            # Update DB
            writes = []
            for fp_str, ftype, _ in file_data:
                if fp_str in hash_results:
                    md5, size, mtime = hash_results[fp_str]
                    writes.append((fp_str, size, mtime, md5, ftype, name, time.time()))
            if writes:
                conn.executemany(
                    "INSERT OR REPLACE INTO file_hashes (filepath,size,mtime,md5,media_type,category,scan_time) VALUES (?,?,?,?,?,?,?)",
                    writes
                )
                conn.commit()

        # Dedup
        seen_in_batch = set()
        cat_unique = 0
        cat_cross = 0
        cat_internal = 0
        for fp_str, ftype, cached_md5 in file_data:
            md5 = cached_md5 if cached_md5 else hash_results.get(fp_str, (None,))[0]
            if md5 is None:
                continue
            if md5 in known_md5_set:
                cat_cross += 1
            elif md5 in seen_in_batch:
                cat_internal += 1
            else:
                seen_in_batch.add(md5)
                all_unique.append((fp_str, md5, ftype, name))
                cat_unique += 1
                known_md5_set.add(md5)

        total_cross_dup += cat_cross
        total_internal_dup += cat_internal
        print(f"    Cache: {len(file_data) - len(need_hash)} hit, {len(need_hash)} hashed")
        print(f"    Unique: {cat_unique}, Cross-dup: {cat_cross}, Internal: {cat_internal}")

    # Symlink unique files
    print(f"\n[3] Creating symlinks for {len(all_unique)} unique files...")
    created = {"image": 0, "video": 0}
    for fp_str, md5, ftype, cat_name in all_unique:
        out_base = OUTPUT_ROOT / ("images" if ftype == "image" else "videos")
        cat_dir = out_base / cat_name
        cat_dir.mkdir(parents=True, exist_ok=True)

        fp = Path(fp_str)
        link_path = cat_dir / fp.name
        if link_path.exists() or link_path.is_symlink():
            stem, ext = fp.stem, fp.suffix
            link_path = cat_dir / f"{stem}_{md5[:8]}{ext}"
        try:
            os.symlink(fp, link_path)
            created[ftype] += 1
        except Exception:
            pass

    elapsed = time.time() - t0
    print(f"\n{'=' * 60}")
    print(f"  RE-SCAN DONE in {elapsed:.1f}s")
    print(f"  Cache hits: {total_cache_hits} | Hashed: {total_need_hash}")
    print(f"  New hashes in DB: {len(known_md5_set) - old_count}")
    print(f"  Unique files linked: {created['image']} img + {created['video']} vid")
    print(f"  Duplicates: {total_cross_dup} cross + {total_internal_dup} internal")
    print(f"{'=' * 60}")
    print_running_totals(conn)


# ============================================================
# FRAME EXTRACTION
# ============================================================

def extract_frame_single(args):
    src, dst, at_sec = args
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(src)],
            capture_output=True, text=True, timeout=10
        )
        if r.returncode != 0:
            return (str(src), False, "ffprobe fail")
        dur = float(r.stdout.strip())
        seek = min(at_sec, max(0, dur - 0.5))

        cmd = ["ffmpeg", "-y", "-ss", str(seek), "-i", str(src),
               "-vframes", "1", "-q:v", "2", str(dst)]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            return (str(src), False, r.stderr[-100:])

        if not dst.exists() or dst.stat().st_size < 1024:
            return (str(src), False, "tiny output")
        return (str(src), True, "ok")
    except subprocess.TimeoutExpired:
        return (str(src), False, "timeout")
    except Exception as e:
        return (str(src), False, str(e))


def cmd_extract_frames(conn, args):
    video_cat = args.video_cat
    at_sec = args.at

    video_dir = OUTPUT_ROOT / "videos" / video_cat
    frame_dir = OUTPUT_ROOT / "images" / f"{video_cat}_frames_{int(at_sec)}s"
    frame_dir.mkdir(parents=True, exist_ok=True)

    if not video_dir.exists():
        print(f"[ERROR] Video category not found: {video_dir}")
        return

    # Collect videos
    videos = []
    for f in sorted(video_dir.iterdir()):
        if f.is_symlink() and f.suffix.lower() in VIDEO_EXTS:
            real = f.resolve()
            if real.exists():
                videos.append((real, f.stem))
        elif f.is_file() and f.suffix.lower() in VIDEO_EXTS:
            videos.append((f, f.stem))

    print(f"  Videos: {len(videos)}")

    # Skip existing
    tasks = []
    skipped = 0
    for real_path, stem in videos:
        dst = frame_dir / f"{stem}.png"
        if dst.exists():
            skipped += 1
        else:
            tasks.append((real_path, dst, at_sec))

    print(f"  To extract: {len(tasks)} (skipped {skipped} existing)")

    t0 = time.time()
    ok = fail = 0
    with ProcessPoolExecutor(max_workers=FRAME_WORKERS) as pool:
        futs = {pool.submit(extract_frame_single, t): t for t in tasks}
        done = 0
        for fut in as_completed(futs):
            _, success, _ = fut.result()
            done += 1
            if success:
                ok += 1
            else:
                fail += 1
            if done % 1000 == 0 or done == len(tasks):
                rate = done / (time.time() - t0) if time.time() > t0 else 0
                print(f"    [{done}/{len(tasks)}] ok={ok} fail={fail} ({rate:.0f}/s)")

    print(f"  Extracted: {ok}, Failed: {fail}")

    # Add frames to hash cache as well
    print(f"\n  Indexing {ok} new frames into hash cache...")
    frame_files = []
    for f in frame_dir.glob("*.png"):
        if not f.is_symlink():
            fp_str = str(f)
            row = conn.execute("SELECT filepath FROM file_hashes WHERE filepath=?", (fp_str,)).fetchone()
            if not row:
                frame_files.append(fp_str)

    if frame_files:
        with ProcessPoolExecutor(max_workers=HASH_WORKERS) as pool:
            futs = {pool.submit(hash_single, fp): fp for fp in frame_files}
            writes = []
            for fut in as_completed(futs):
                fp, md5, size, mtime = fut.result()
                if md5:
                    writes.append((fp, size, mtime, md5, "image", f"{video_cat}_frames_{int(at_sec)}s", time.time()))
            if writes:
                conn.executemany(
                    "INSERT OR REPLACE INTO file_hashes (filepath,size,mtime,md5,media_type,category,scan_time) VALUES (?,?,?,?,?,?,?)",
                    writes
                )
                conn.commit()
        print(f"  Indexed {len(writes)} frames")


# ============================================================
# STATUS & HELPERS
# ============================================================

def print_running_totals(conn):
    """Print current grand totals from output dirs."""
    total_img = 0
    total_vid = 0
    img_base = OUTPUT_ROOT / "images"
    vid_base = OUTPUT_ROOT / "videos"

    if img_base.exists():
        for cat in img_base.iterdir():
            if cat.is_dir():
                total_img += len(list(cat.iterdir()))
    if vid_base.exists():
        for cat in vid_base.iterdir():
            if cat.is_dir():
                if cat.name == "fapify_trimmed":
                    for sub in cat.iterdir():
                        if sub.is_dir():
                            total_vid += len(list(sub.iterdir()))
                else:
                    total_vid += len(list(cat.iterdir()))

    print(f"\n  ── GRAND TOTAL ──")
    print(f"  Images: {total_img:,}")
    print(f"  Videos: {total_vid:,}")
    print(f"  Total:  {total_img + total_vid:,}")
    print(f"  ────────────────")


def cmd_status(conn, args):
    """Show DB stats and current asset totals."""
    total = conn.execute("SELECT COUNT(*) FROM file_hashes").fetchone()[0]
    unique = conn.execute("SELECT COUNT(DISTINCT md5) FROM file_hashes").fetchone()[0]
    dupes = total - unique
    sources = conn.execute("SELECT COUNT(*) FROM sources").fetchone()[0]
    db_size = DB_PATH.stat().st_size / (1024 * 1024)

    # Category breakdown from DB
    cursor = conn.execute(
        "SELECT category, media_type, COUNT(*) FROM file_hashes GROUP BY category, media_type ORDER BY COUNT(*) DESC"
    )
    print("=" * 60)
    print("  ASSET ORGANIZER STATUS")
    print("=" * 60)
    print(f"\n  DB: {DB_PATH} ({db_size:.1f} MB)")
    print(f"  Total files hashed: {total:,}")
    print(f"  Unique hashes: {unique:,}")
    print(f"  Duplicates detected: {dupes:,}")
    print(f"  Registered sources: {sources}")

    print(f"\n  {'Category':<30s} {'Type':<8s} {'Count':>8s}")
    print(f"  {'-'*30} {'-'*8} {'-'*8}")
    for cat, mtype, count in cursor:
        print(f"  {cat:<30s} {mtype:<8s} {count:>8,}")

    # Source list
    cursor = conn.execute("SELECT name, path, media_type, recursive FROM sources")
    sources_list = cursor.fetchall()
    if sources_list:
        print(f"\n  Registered Sources:")
        for name, path, mtype, rec in sources_list:
            print(f"    {name:<25s} {mtype:<8s} {'rec' if rec else 'flat':<6s} {path}")

    print_running_totals(conn)


def cmd_list_sources(conn, args):
    """List registered sources."""
    cursor = conn.execute("SELECT name, path, media_type, recursive, registered FROM sources ORDER BY registered")
    rows = cursor.fetchall()
    if not rows:
        print("  No sources registered.")
        return
    print(f"\n  {'Name':<25s} {'Type':<8s} {'Rec':>4s} {'Path'}")
    print(f"  {'-'*25} {'-'*8} {'-'*4} {'-'*50}")
    for name, path, mtype, rec, ts in rows:
        t = time.strftime("%Y-%m-%d", time.localtime(ts))
        print(f"  {name:<25s} {mtype:<8s} {'Y' if rec else 'N':>4s} {path}")
    print()


# ============================================================
# CLI
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="Asset Organizer with SQLite hash cache",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command")

    # add
    p_add = sub.add_parser("add", help="Add a new source")
    p_add.add_argument("name", help="Category name (e.g. 'spicy_new')")
    p_add.add_argument("path", help="Source directory path")
    p_add.add_argument("--type", choices=["image", "video", "auto"], default="auto",
                       help="Media type (default: auto-detect)")
    p_add.add_argument("--recursive", action="store_true", help="Scan subdirectories")

    # scan
    sub.add_parser("scan", help="Re-scan ALL registered sources (cache-accelerated)")

    # status
    sub.add_parser("status", help="Show DB stats and current totals")

    # list-sources
    sub.add_parser("list-sources", help="List registered sources")

    # extract-frames
    p_frame = sub.add_parser("extract-frames", help="Extract frames from a video category")
    p_frame.add_argument("video_cat", help="Video category name (e.g. 'spicy_adult')")
    p_frame.add_argument("--at", type=float, default=4.0, help="Seconds to extract at (default: 4.0)")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return

    conn = init_db()

    commands = {
        "add": cmd_add,
        "scan": cmd_scan,
        "status": cmd_status,
        "list-sources": cmd_list_sources,
        "extract-frames": cmd_extract_frames,
    }

    commands[args.command](conn, args)
    conn.close()


if __name__ == "__main__":
    main()
