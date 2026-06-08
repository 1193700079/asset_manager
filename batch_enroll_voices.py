#!/usr/bin/env python3
"""
Batch Voice Enrollment CLI
---------------------------
Processes audio_library records with status='online' and assigned_to IS NOT NULL,
enrolls each via CosyVoice API, and updates the corresponding character's voice_id.

Usage:
    cd character-manager/backend
    python ../../batch_enroll_voices.py                   # Batch all online audio
    python ../../batch_enroll_voices.py --dry-run         # Preview only
    python ../../batch_enroll_voices.py --char-id 42      # Single character
    python ../../batch_enroll_voices.py --no-skip          # Re-enroll existing
"""
import sys
import os
import time
import argparse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "character-manager", "backend"))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "character-manager", "backend", ".env"))

from database import init_pool, get_conn, put_conn, close_pool
import psycopg2.extras
from services.voice_enrollment import enroll_voice, is_valid_cosyvoice_id, RATE_LIMIT_SLEEP


def main():
    parser = argparse.ArgumentParser(description="Batch enroll voices via CosyVoice")
    parser.add_argument("--dry-run", action="store_true", help="Preview only")
    parser.add_argument("--char-id", type=int, help="Process specific character only")
    parser.add_argument("--no-skip", action="store_true", help="Re-enroll even if already has CosyVoice voice_id")
    args = parser.parse_args()

    print("=" * 60)
    print("  Batch Voice Enrollment: audio_library -> CosyVoice")
    print("=" * 60)
    if args.dry_run:
        print("  MODE: DRY RUN")
    print()

    init_pool()
    conn = get_conn()

    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if args.char_id:
                cur.execute("""
                    SELECT a.id as audio_id, a.filename, a.oss_url,
                           c.id as char_id, c.name, c.voice_id
                    FROM audio_library a
                    JOIN characters c ON c.id = a.assigned_to
                    WHERE a.assigned_to = %s AND a.status = 'online' AND a.oss_url IS NOT NULL
                """, (args.char_id,))
            else:
                cur.execute("""
                    SELECT a.id as audio_id, a.filename, a.oss_url,
                           c.id as char_id, c.name, c.voice_id
                    FROM audio_library a
                    JOIN characters c ON c.id = a.assigned_to
                    WHERE a.status = 'online' AND a.assigned_to IS NOT NULL AND a.oss_url IS NOT NULL
                    ORDER BY c.name
                """)
            records = [dict(r) for r in cur.fetchall()]

        if not records:
            print("No eligible records found (status=online, assigned_to IS NOT NULL).")
            return

        print(f"Found {len(records)} eligible record(s).\n")

        stats = {"success": 0, "failed": 0, "skipped": 0, "total": len(records)}

        for i, rec in enumerate(records, 1):
            print(f"--- [{i}/{stats['total']}] {rec['name']} (id={rec['char_id']}) ---")
            print(f"  Audio: {rec['filename']}")
            print(f"  URL: {rec['oss_url']}")
            print(f"  Current voice_id: {rec['voice_id']}")

            if not args.no_skip and is_valid_cosyvoice_id(rec["voice_id"]):
                print("  SKIP: Already has CosyVoice voice_id")
                stats["skipped"] += 1
                print()
                continue

            if args.dry_run:
                print(f"  [DRY RUN] Would enroll")
                stats["success"] += 1
                print()
                continue

            voice_id = enroll_voice(rec["oss_url"], prefix=rec["name"])

            if voice_id:
                with conn.cursor() as cur:
                    cur.execute("UPDATE characters SET voice_id = %s WHERE id = %s",
                                (voice_id, rec["char_id"]))
                conn.commit()
                print(f"  OK: voice_id = {voice_id}")
                stats["success"] += 1
            else:
                print("  FAILED")
                stats["failed"] += 1

            print()
            if i < stats["total"]:
                time.sleep(RATE_LIMIT_SLEEP)

        print("=" * 60)
        print(f"  Total:      {stats['total']}")
        print(f"  Success:    {stats['success']}")
        print(f"  Failed:     {stats['failed']}")
        print(f"  Skipped:    {stats['skipped']}")
        print("=" * 60)

    finally:
        put_conn(conn)
        close_pool()


if __name__ == "__main__":
    main()
