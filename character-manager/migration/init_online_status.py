"""One-time: set existing (non-deleted) characters to character_status='online'.

Why: the live backends (priya / candy-ecjoy) now hide characters whose
character_status != 'online'. The DB column defaults to 'pending', so without
this backfill every existing character would disappear from the apps.

Runs against both data sources defined in CM config. Idempotent.

Usage (DRY by default):
  cd character-manager/backend && python ../migration/init_online_status.py
  cd character-manager/backend && python ../migration/init_online_status.py --apply
"""
import os
import sys

sys.path.insert(0, "/mnt/cypher/project/asset_manager/character-manager/backend")

import psycopg2
from config import settings

APPLY = "--apply" in sys.argv

# priya pooler URL fallback (CM .env injects PRIYA_DATABASE_URL when run from backend dir)
DATASOURCES = dict(settings.datasources)
if "priya" not in DATASOURCES:
    DATASOURCES["priya"] = (
        "postgresql://postgres.ixfygihkryfsunqeowza:YRQ21163x%21priya"
        "@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"
    )


def run(name, url):
    conn = psycopg2.connect(url, connect_timeout=20)
    conn.autocommit = False
    cur = conn.cursor()
    cur.execute(
        """SELECT count(*) FROM characters
           WHERE (is_deleted IS NULL OR is_deleted = FALSE)
             AND COALESCE(character_status,'pending') <> 'online'"""
    )
    pending = cur.fetchone()[0]
    print(f"[{name}] {pending} non-online existing characters")
    if APPLY and pending:
        cur.execute(
            """UPDATE characters SET character_status = 'online'
               WHERE (is_deleted IS NULL OR is_deleted = FALSE)
                 AND COALESCE(character_status,'pending') <> 'online'"""
        )
        conn.commit()
        print(f"[{name}] set {cur.rowcount} characters to online")
    elif not APPLY:
        print(f"[{name}] DRY-RUN (no writes); pass --apply to update")
    conn.close()


if __name__ == "__main__":
    for nm, u in DATASOURCES.items():
        run(nm, u)
    print("DONE")
