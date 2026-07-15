#!/usr/bin/env python3
"""Ingest ATC-ASR audio into CM system:
1. Clip to 15s MP3
2. Upload to OSS
3. Insert into audio_library with ethnicity category
4. Auto-assign to characters matching ethnicity

Usage:
    python ingest_atc_audio.py [--dry-run] [--limit N] [--skip-upload] [--auto-assign]
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from collections import Counter, defaultdict

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import psycopg2
import psycopg2.extras
import oss2

from config import settings
from database import init_pool, get_conn, put_conn, close_pool

CLASSIFICATION_FILE = "/mnt/data/ATC-ASR-Dataset/classification/stage2_classifications.jsonl"
AUDIO_DIR = "/mnt/data/ATC-ASR-Dataset/audio"
OSS_PREFIX = "candy_ai/audio"
CLIP_DURATION = 15
MIN_CONFIDENCE = 0.3

ETHNICITY_TO_GROUP = {
    "Caucasian": "Caucasian",
    "Celtic_BritishIsles": "Caucasian",
    "EastEuropean_Romani": "Caucasian",
    "Nordic_Scandinavian": "Caucasian",
    "Baltic_European": "Caucasian",
    "CentralEuropean_Slavic": "Caucasian",
    "CentralEuropean_Germanic": "Caucasian",
    "CentralEuropean_Hungarian": "Caucasian",
    "CentralEuropean_Czech": "Caucasian",
    "CentralEuropean": "Caucasian",
    "CentralEuropean_German": "Caucasian",
    "CentralEuropean_Magyar": "Caucasian",
    "CentralEuropean_Slovenian": "Caucasian",
    "CentralEuropean_Romani": "Caucasian",
    "Balkan_Slavic": "Caucasian",
    "Balkan_Serbian": "Caucasian",
    "Balkan_SouthSlavic": "Caucasian",
    "Balkan_SoutheastEuropean": "Caucasian",
    "Slavic_EasternEuropean": "Caucasian",
    "Iberian_Peninsula": "Caucasian",
    "French": "Caucasian",
    "Basque": "Caucasian",
    "Romance_Language_Speaker": "Caucasian",
    "Asian_East": "Asian",
    "Asian_Southeast": "Asian",
    "EastAsian_Siberian": "Asian",
    "Southeast_Asian_Hmong": "Asian",
    "SoutheastAsian_Hmong": "Asian",
    "SouthEastAsian_Southern": "Asian",
    "Hispanic_Latino": "Hispanic/Latino",
    "Andean_SouthAmerican": "Hispanic/Latino",
    "SouthAmerican_Indigenous": "Hispanic/Latino",
    "Amazonian_Indigenous": "Hispanic/Latino",
    "Mixed_Indigenous_Caribbean": "Hispanic/Latino",
    "Caribbean_Indigenous": "Hispanic/Latino",
    "Asian_South": "South Asian",
    "SouthIndian_Dravidian": "South Asian",
    "SouthAsian_NorthIndian": "South Asian",
    "SouthAsian_Bengali": "South Asian",
    "SouthAsian_Urdu": "South Asian",
    "SouthAsian_IndoAryan": "South Asian",
    "SouthAsian_Sinhalese": "South Asian",
    "SouthAsian_Maldivian": "South Asian",
    "MiddleEastern": "Middle Eastern",
    "MiddleEastern_Caucasian": "Middle Eastern",
    "Levantine_Mediterranean": "Middle Eastern",
    "Arabian_Peninsula": "Middle Eastern",
    "Anatolian_Turkic": "Middle Eastern",
    "NorthAfrican_Berber": "Middle Eastern",
    "Black_AfricanAmerican": "African American",
    "Southern_African_Bantu": "African American",
    "Sahelian_African": "African American",
    "WestAfrican_Yoruba": "African American",
    "African_Bantu": "African American",
    "Mixed": "Mixed",
    "Central_Asian_Steppe": "Mixed",
    "CentralAsian_Steppe": "Mixed",
    "Pacific_Islander_Polynesian": "Mixed",
    "Polynesian_Oceanic": "Mixed",
    "Oceanic_Melanesian": "Mixed",
    "Australian_Aboriginal": "Mixed",
    "NorthAmerican_Indigenous": "Mixed",
    "Scandinavian_Baltic": "Caucasian",
    "Caucasian_Mediterranean": "Mediterranean",
    "Mediterranean": "Mediterranean",
}

CHAR_ETH_MAP = {
    "Caucasian": ["Caucasian", "Caucasian (Mediterranean)", "Caucasian (Mediterranean descent)", "Caucasian (Middle Eastern descent)"],
    "Asian": ["Asian", "Japanese"],
    "Hispanic/Latino": ["Latina", "Latino", "Hispanic", "Hispanic/Latino"],
    "South Asian": ["South Asian"],
    "Middle Eastern": ["Middle Eastern", "Arab", "Mediterranean"],
    "African American": ["African American", "Black/Afro", "Black"],
    "Mixed": ["Mixed", "Mixed (Japanese/Caucasian)"],
}


def compute_hash(filepath):
    h = hashlib.md5()
    with open(filepath, "rb") as f:
        h.update(f.read(65536))
    return h.hexdigest()


def clip_audio(src, dst, duration=CLIP_DURATION):
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", src, "-t", str(duration),
             "-acodec", "libmp3lame", "-ab", "128k", "-ar", "44100",
             "-ac", "1", dst],
            capture_output=True, timeout=60,
        )
        return Path(dst).exists() and Path(dst).stat().st_size > 1000
    except Exception as e:
        print(f"  ffmpeg error: {e}")
        return False


def get_duration(filepath):
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", filepath],
            capture_output=True, text=True, timeout=10,
        )
        return float(result.stdout.strip())
    except Exception:
        return None


def upload_to_oss(local_path, oss_key):
    auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)
    bucket = oss2.Bucket(auth, settings.oss_endpoint, settings.oss_bucket)
    bucket.put_object_from_file(oss_key, local_path)
    endpoint = settings.oss_endpoint.replace("https://", "").replace("http://", "")
    return f"https://{settings.oss_bucket}.{endpoint}/{oss_key}"


def load_classifications():
    items = []
    with open(CLASSIFICATION_FILE) as f:
        for line in f:
            item = json.loads(line.strip())
            if item.get("status") != "success":
                continue
            if item.get("confidence", 0) < MIN_CONFIDENCE:
                continue
            eth = item["ethnicity"]
            group = ETHNICITY_TO_GROUP.get(eth)
            if not group:
                continue
            items.append({
                "id": item["id"],
                "ethnicity": eth,
                "group": group,
                "confidence": item["confidence"],
                "split": item.get("split", "unknown"),
            })
    return items


def main():
    dry_run = "--dry-run" in sys.argv
    skip_upload = "--skip-upload" in sys.argv
    auto_assign = "--auto-assign" in sys.argv
    limit = None
    if "--limit" in sys.argv:
        idx = sys.argv.index("--limit")
        limit = int(sys.argv[idx + 1])

    init_pool()
    conn = get_conn()

    classifications = load_classifications()
    print(f"Loaded {len(classifications)} classifications (confidence >= {MIN_CONFIDENCE})")

    group_counts = Counter(c["group"] for c in classifications)
    print(f"\nGroup distribution:")
    for g, cnt in group_counts.most_common():
        print(f"  {g:20s} {cnt:5d}")

    with conn.cursor() as cur:
        cur.execute("SELECT file_hash FROM audio_library")
        existing_hashes = {row[0] for row in cur.fetchall()}
    print(f"\nExisting audio_library entries: {len(existing_hashes)}")

    if limit:
        classifications = classifications[:limit]

    inserted = 0
    skipped_dup = 0
    skipped_err = 0
    group_inserted = Counter()

    with tempfile.TemporaryDirectory(prefix="atc_clip_") as tmp_dir:
        for i, cls in enumerate(classifications):
            if i % 200 == 0 and i > 0:
                print(f"  progress: {i}/{len(classifications)} inserted={inserted} dup={skipped_dup} err={skipped_err}")

            wav_path = os.path.join(AUDIO_DIR, cls["split"], f"{cls['id']}.wav")
            if not os.path.exists(wav_path):
                skipped_err += 1
                continue

            file_hash = compute_hash(wav_path)
            if file_hash in existing_hashes:
                skipped_dup += 1
                continue

            clip_path = os.path.join(tmp_dir, f"{file_hash}.mp3")
            if not clip_audio(wav_path, clip_path):
                skipped_err += 1
                continue

            dur = get_duration(clip_path)

            if dry_run:
                print(f"  [dry] {cls['id']} -> {cls['group']} ({cls['ethnicity']}) dur={dur:.1f}s")
                inserted += 1
                group_inserted[cls["group"]] += 1
                continue

            oss_key = f"{OSS_PREFIX}/atc_{cls['group'].lower().replace(' ', '_').replace('/', '_')}/{file_hash}.mp3"

            if not skip_upload:
                try:
                    oss_url = upload_to_oss(clip_path, oss_key)
                except Exception as e:
                    print(f"  OSS upload error: {e}")
                    skipped_err += 1
                    continue
            else:
                endpoint = settings.oss_endpoint.replace("https://", "").replace("http://", "")
                oss_url = f"https://{settings.oss_bucket}.{endpoint}/{oss_key}"

            category = f"atc_{cls['group'].lower().replace(' ', '_').replace('/', '_')}"

            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO audio_library (filename, original_path, category, duration, file_hash, oss_url, oss_key)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (file_hash) DO NOTHING
                """, (f"{cls['id']}.wav", wav_path, category, dur, file_hash, oss_url, oss_key))
            conn.commit()

            existing_hashes.add(file_hash)
            inserted += 1
            group_inserted[cls["group"]] += 1

    print(f"\n{'=' * 50}")
    print(f"Ingestion complete!")
    print(f"  Inserted: {inserted}")
    print(f"  Skipped (dup): {skipped_dup}")
    print(f"  Skipped (err): {skipped_err}")
    print(f"\nBy group:")
    for g, cnt in group_inserted.most_common():
        print(f"  {g:20s} {cnt:5d}")

    if auto_assign and not dry_run:
        print(f"\n{'=' * 50}")
        print("Auto-assigning audio to characters...")
        auto_assign_audio(conn)

    put_conn(conn)
    close_pool()


def auto_assign_audio(conn):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            SELECT id, name, category, attributes->>'Ethnicity' as ethnicity
            FROM characters
            WHERE (is_deleted IS NULL OR is_deleted = FALSE)
              AND creator_id IN ('official', 'system')
              AND voice_id IS NULL
            ORDER BY category, name
        """)
        chars_no_voice = cur.fetchall()

    print(f"Characters without voice: {len(chars_no_voice)}")

    assigned_total = 0
    for ch in chars_no_voice:
        char_eth = ch["ethnicity"] or "Caucasian"

        matching_groups = []
        for group, char_eths in CHAR_ETH_MAP.items():
            if char_eth in char_eths:
                matching_groups.append(group)
                break

        if not matching_groups:
            matching_groups = ["Caucasian"]

        categories = [f"atc_{g.lower().replace(' ', '_').replace('/', '_')}" for g in matching_groups]
        placeholders = ",".join(["%s"] * len(categories))

        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(f"""
                SELECT id FROM audio_library
                WHERE assigned_to IS NULL
                  AND (status IS NULL OR status = '')
                  AND oss_url IS NOT NULL
                  AND category IN ({placeholders})
                ORDER BY random()
                LIMIT 3
            """, categories)
            picks = [r["id"] for r in cur.fetchall()]

            if not picks:
                cur.execute("""
                    SELECT id FROM audio_library
                    WHERE assigned_to IS NULL
                      AND (status IS NULL OR status = '')
                      AND oss_url IS NOT NULL
                      AND category LIKE 'atc_%%'
                    ORDER BY random()
                    LIMIT 3
                """)
                picks = [r["id"] for r in cur.fetchall()]

            for aid in picks:
                cur.execute(
                    "UPDATE audio_library SET assigned_to = %s, status = 'pending' WHERE id = %s",
                    (ch["id"], aid),
                )
            assigned_total += len(picks)

            if picks:
                print(f"  {ch['name']:30s} ({char_eth:20s}) -> {len(picks)} candidates ({', '.join(categories)})")

    conn.commit()
    print(f"\nAuto-assigned {assigned_total} audio to {len(chars_no_voice)} characters")


if __name__ == "__main__":
    main()
