#!/usr/bin/env python3
"""Scan audio directory, deduplicate, clip to 15s, upload to OSS, insert into audio_library.

Usage:
    python scripts/scan_audio.py [--dry-run] [--limit N]

Expects:
    - ffmpeg on PATH
    - OSS credentials in .env / config
    - PostgreSQL connection via database module
"""
import hashlib
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import psycopg2
import psycopg2.extras
import oss2

from config import settings
from database import init_pool, get_conn, put_conn, close_pool

AUDIO_ROOT = Path("/mnt/cypher/project/asset_manager/audio")
CLIP_DURATION = 15
OSS_PREFIX = "candy_ai/audio"
VALID_EXTS = {".mp3", ".m4a", ".wav", ".flac", ".aac", ".wma"}


def classify_category(original_path: str) -> str:
    p = original_path.lower()
    if "韩" in p or "korean" in p:
        return "korean"
    if "中" in p or "chinese" in p:
        return "chinese"
    return "japanese"


def compute_hash(filepath: str) -> str:
    h = hashlib.md5()
    with open(filepath, "rb") as f:
        chunk = f.read(65536)
        h.update(chunk)
    return h.hexdigest()


def get_duration(filepath: str) -> float | None:
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", filepath],
            capture_output=True, text=True, timeout=10,
        )
        return float(result.stdout.strip())
    except Exception:
        return None


def clip_audio(src: str, dst: str, duration: int = CLIP_DURATION) -> bool:
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", src, "-t", str(duration),
             "-acodec", "libmp3lame", "-ab", "128k", "-ar", "44100",
             "-ac", "1", dst],
            capture_output=True, timeout=60,
        )
        return Path(dst).exists() and Path(dst).stat().st_size > 1000
    except Exception as e:
        print(f"  ffmpeg failed: {e}")
        return False


def upload_to_oss(local_path: str, oss_key: str) -> str:
    auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)
    bucket = oss2.Bucket(auth, settings.oss_endpoint, settings.oss_bucket)
    bucket.put_object_from_file(oss_key, local_path)
    endpoint = settings.oss_endpoint.replace("https://", "").replace("http://", "")
    return f"https://{settings.oss_bucket}.{endpoint}/{oss_key}"


def main():
    dry_run = "--dry-run" in sys.argv
    limit = None
    if "--limit" in sys.argv:
        idx = sys.argv.index("--limit")
        limit = int(sys.argv[idx + 1])

    init_pool()
    conn = get_conn()

    # Ensure table
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS audio_library (
                id SERIAL PRIMARY KEY,
                filename TEXT NOT NULL,
                original_path TEXT NOT NULL,
                category TEXT NOT NULL,
                duration FLOAT,
                file_hash TEXT UNIQUE NOT NULL,
                oss_url TEXT,
                oss_key TEXT,
                assigned_to INTEGER,
                created_at TIMESTAMP DEFAULT NOW()
            )
        """)
    conn.commit()

    # Load existing hashes
    with conn.cursor() as cur:
        cur.execute("SELECT file_hash FROM audio_library")
        existing_hashes = {row[0] for row in cur.fetchall()}
    print(f"[scan] {len(existing_hashes)} existing entries in DB")

    # Collect all audio symlinks
    all_files = []
    for entry in AUDIO_ROOT.rglob("*"):
        if entry.is_symlink() or entry.is_file():
            ext = entry.suffix.lower()
            if ext in VALID_EXTS:
                all_files.append(entry)

    print(f"[scan] found {len(all_files)} audio files")
    if limit:
        all_files = all_files[:limit]

    processed = 0
    skipped_dup = 0
    skipped_err = 0
    inserted = 0

    with tempfile.TemporaryDirectory(prefix="audio_clip_") as tmp_dir:
        for i, fpath in enumerate(all_files):
            if i % 500 == 0 and i > 0:
                print(f"  progress: {i}/{len(all_files)} (inserted={inserted}, dup={skipped_dup})")

            try:
                real_path = str(fpath.resolve())
                file_hash = compute_hash(real_path)

                if file_hash in existing_hashes:
                    skipped_dup += 1
                    continue

                # Classify
                original_target = os.readlink(str(fpath)) if fpath.is_symlink() else str(fpath)
                category = classify_category(original_target)

                # Clip to 15s
                clip_path = os.path.join(tmp_dir, f"{file_hash}.mp3")
                if not clip_audio(real_path, clip_path):
                    skipped_err += 1
                    continue

                # Get duration of clip
                dur = get_duration(clip_path)

                if dry_run:
                    print(f"  [dry] {fpath.name} -> {category} hash={file_hash[:8]} dur={dur:.1f}s")
                    inserted += 1
                    continue

                # Upload to OSS
                oss_key = f"{OSS_PREFIX}/{category}/{file_hash}.mp3"
                oss_url = upload_to_oss(clip_path, oss_key)

                # Insert into DB
                with conn.cursor() as cur:
                    cur.execute("""
                        INSERT INTO audio_library (filename, original_path, category, duration, file_hash, oss_url, oss_key)
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (file_hash) DO NOTHING
                    """, (fpath.name, original_target, category, dur, file_hash, oss_url, oss_key))
                conn.commit()

                existing_hashes.add(file_hash)
                inserted += 1
                processed += 1

            except Exception as e:
                skipped_err += 1
                if skipped_err <= 10:
                    print(f"  error: {fpath.name}: {e}")

    put_conn(conn)
    close_pool()

    print(f"\n[scan] Done!")
    print(f"  Total files: {len(all_files)}")
    print(f"  Inserted: {inserted}")
    print(f"  Skipped (duplicate): {skipped_dup}")
    print(f"  Skipped (error): {skipped_err}")


if __name__ == "__main__":
    main()
