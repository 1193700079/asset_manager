#!/usr/bin/env python3
"""
Fix expired signed URLs in characters.media JSON.
- Removes media entries with x-oss-expires (expired SmartStudio URLs)
- Outputs a report of affected characters for regeneration
"""
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "character-manager", "backend"))

from database import init_pool, get_conn, put_conn, close_pool
import psycopg2.extras


def main():
    dry_run = "--dry-run" in sys.argv

    init_pool()
    conn = get_conn()

    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT id, name, category, media,
                       jsonb_array_length(COALESCE(media::jsonb, '[]'::jsonb)) as media_count
                FROM characters
                WHERE is_deleted = false
                  AND media IS NOT NULL
                  AND media::text LIKE '%%x-oss-expires%%'
                ORDER BY name
            """)
            rows = cur.fetchall()

        if not rows:
            print("No characters with signed URLs found.")
            return

        print(f"Found {len(rows)} characters with signed URLs")
        print(f"Mode: {'DRY RUN' if dry_run else 'LIVE'}\n")

        report = []
        total_removed = 0

        for row in rows:
            media = row["media"]
            if isinstance(media, str):
                media = json.loads(media)

            original_count = len(media)
            clean_media = []
            removed = []

            for m in media:
                if isinstance(m, dict):
                    url = m.get("url", "")
                    if "x-oss-expires" in url or "ai-insight-dev" in url:
                        removed.append(m)
                    else:
                        clean_media.append(m)
                else:
                    clean_media.append(m)

            removed_count = len(removed)
            total_removed += removed_count

            if removed_count > 0:
                report.append({
                    "id": row["id"],
                    "name": row["name"],
                    "category": row["category"],
                    "original_media": original_count,
                    "removed": removed_count,
                    "remaining": len(clean_media),
                })

                print(f"  {row['name']:25s} (id={row['id']:4d}) "
                      f"{row['category']:15s} "
                      f"media: {original_count} -> {len(clean_media)} "
                      f"(removed {removed_count})")

                if not dry_run:
                    with conn.cursor() as cur2:
                        cur2.execute(
                            "UPDATE characters SET media = %s::json WHERE id = %s",
                            (json.dumps(clean_media), row["id"]),
                        )

        if not dry_run:
            conn.commit()

        print(f"\n{'=' * 60}")
        print(f"  Total characters: {len(rows)}")
        print(f"  Total removed:    {total_removed}")
        print(f"{'=' * 60}")

        if report:
            report_path = "/mnt/data/signed_url_cleanup_report.json"
            with open(report_path, "w") as f:
                json.dump(report, f, indent=2, ensure_ascii=False)
            print(f"\n  Report saved to: {report_path}")
            print(f"\n  Characters needing regeneration:")
            for r in report:
                print(f"    id={r['id']:4d} {r['name']:25s} ({r['category']:15s}) "
                      f"lost {r['removed']} imgs, {r['remaining']} remaining")

    finally:
        put_conn(conn)
        close_pool()


if __name__ == "__main__":
    main()
