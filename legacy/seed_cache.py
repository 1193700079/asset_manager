#!/usr/bin/env python3
"""
Seed the SQLite hash cache from existing organized assets.
One-time operation: reads all symlinks in images/ and videos/,
computes MD5, stores in hash_cache.db.

After this, subsequent organizer.py runs only hash NEW files.
"""
import hashlib, os, sqlite3, time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

OUTPUT_ROOT = Path("/mnt/cypher/project/asset_manager")
DB_PATH = OUTPUT_ROOT / "hash_cache.db"
WORKERS = 64

def hash_one(args):
    fp_str, cat, mtype = args
    h = hashlib.md5()
    try:
        st = os.stat(fp_str)
        with open(fp_str, "rb") as f:
            while True:
                chunk = f.read(131072)
                if not chunk:
                    break
                h.update(chunk)
        return (fp_str, h.hexdigest(), st.st_size, st.st_mtime, mtype, cat)
    except Exception:
        return None

def main():
    print("=" * 60)
    print("  SEEDING HASH CACHE FROM EXISTING ASSETS")
    print("=" * 60)

    t0 = time.time()

    # Init DB
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS file_hashes (
            filepath    TEXT PRIMARY KEY,
            size        INTEGER NOT NULL,
            mtime       REAL NOT NULL,
            md5         TEXT NOT NULL,
            media_type  TEXT NOT NULL,
            category    TEXT NOT NULL,
            scan_time   REAL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sources (
            name        TEXT PRIMARY KEY,
            path        TEXT NOT NULL,
            media_type  TEXT NOT NULL,
            recursive   INTEGER NOT NULL DEFAULT 0,
            registered  REAL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_md5 ON file_hashes(md5)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_category ON file_hashes(category)")
    conn.commit()

    # Check if already seeded
    count = conn.execute("SELECT COUNT(*) FROM file_hashes").fetchone()[0]
    if count > 0:
        print(f"\n  DB already has {count} entries. Skipping seed.")
        print("  To rebuild: delete hash_cache.db and re-run.")
        conn.close()
        return

    # Collect all files
    print("\n[1] Collecting existing assets...")
    tasks = []
    for sub in ["images", "videos"]:
        base = OUTPUT_ROOT / sub
        if not base.exists():
            continue
        for cat_dir in base.iterdir():
            if not cat_dir.is_dir():
                continue
            cat_name = cat_dir.name
            if cat_name == "fapify_trimmed":
                continue  # actual files, not symlinks
            for f in cat_dir.iterdir():
                if f.is_symlink():
                    real = f.resolve()
                    if real.exists():
                        mtype = "image" if sub == "images" else "video"
                        tasks.append((str(real), cat_name, mtype))

    print(f"    Found {len(tasks)} files to hash")

    # Hash in parallel
    print(f"\n[2] Hashing {len(tasks)} files ({WORKERS} workers)...")
    print("    This is a one-time operation, ~5-10 min for 90K files...")

    done = 0
    ok = 0
    batch = []
    t_hash = time.time()

    with ProcessPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(hash_one, t): t for t in tasks}
        for future in as_completed(futures):
            result = future.result()
            done += 1
            if result:
                batch.append(result)
                ok += 1

            if done % 5000 == 0:
                rate = done / (time.time() - t_hash)
                eta = (len(tasks) - done) / rate
                print(f"    ... {done:,}/{len(tasks):,} ({rate:.0f}/s, ETA {eta:.0f}s)")

    print(f"    Hashed {ok} files in {time.time()-t_hash:.1f}s")

    # Bulk insert
    print(f"\n[3] Inserting {len(batch)} entries into SQLite...")
    now = time.time()
    conn.executemany(
        "INSERT OR REPLACE INTO file_hashes (filepath, size, mtime, md5, media_type, category, scan_time) VALUES (?,?,?,?,?,?,?)",
        [(fp, sz, mt, md, mty, cat, now) for fp, md, sz, mt, mty, cat in batch]
    )
    conn.commit()

    total = conn.execute("SELECT COUNT(*) FROM file_hashes").fetchone()[0]
    unique = conn.execute("SELECT COUNT(DISTINCT md5) FROM file_hashes").fetchone()[0]
    db_size = DB_PATH.stat().st_size / (1024*1024)
    dupes = total - unique

    elapsed = time.time() - t0
    print(f"\n{'=' * 60}")
    print(f"  SEED COMPLETE in {elapsed:.1f}s")
    print(f"  Total entries: {total:,}")
    print(f"  Unique hashes: {unique:,}")
    print(f"  Duplicates: {dupes:,}")
    print(f"  DB size: {db_size:.1f} MB")
    print(f"{'=' * 60}")

    conn.close()

if __name__ == "__main__":
    main()
