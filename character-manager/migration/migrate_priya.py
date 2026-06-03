"""
Migrate priya.db (SQLite) -> priya Supabase (Postgres), using the union schema.

Steps:
  1. Connect to priya Postgres (IPv4 pooler) and SQLite source.
  2. Apply union DDL (priya_union_schema.sql) -- CREATE TABLE IF NOT EXISTS.
  3. For each SQLite table that also exists in PG, copy rows using the
     intersection of columns. Convert booleans (0/1 -> bool) and ensure JSON
     columns are valid JSON strings.
  4. Reset identity sequences to MAX(id).

Read-only against ecjoy. Writes ONLY to priya Postgres.

Env:
  PRIYA_PG_URL  - target Postgres connection string (IPv4 pooler).

Usage:
  DRY (default): python migrate_priya.py        -> prints plan, no writes
  APPLY:         python migrate_priya.py --apply -> creates tables + loads data
"""
import json
import os
import sqlite3
import sys

import psycopg2
import psycopg2.extras

HERE = os.path.dirname(os.path.abspath(__file__))
SQLITE_PATH = "/mnt/user/joseph/projects/priya_ai/priya-backend/priya.db"
DDL_PATH = os.path.join(HERE, "priya_union_schema.sql")

PRIYA_PG_URL = os.getenv(
    "PRIYA_PG_URL",
    "postgresql://postgres.ixfygihkryfsunqeowza:YRQ21163x%21priya"
    "@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres",
)

APPLY = "--apply" in sys.argv


def pg_schema(conn):
    """Return {table: {col: data_type}} and {table: bool_cols}, {table: json_cols}."""
    cur = conn.cursor()
    cur.execute(
        """SELECT table_name, column_name, data_type
           FROM information_schema.columns
           WHERE table_schema='public'"""
    )
    cols, bools, jsons = {}, {}, {}
    for t, c, dt in cur.fetchall():
        cols.setdefault(t, {})[c] = dt
        if dt == "boolean":
            bools.setdefault(t, set()).add(c)
        if dt in ("json", "jsonb"):
            jsons.setdefault(t, set()).add(c)
    return cols, bools, jsons


def main():
    print(f"Source SQLite: {SQLITE_PATH}")
    print(f"Target PG    : {PRIYA_PG_URL.split('@')[-1]}")
    print(f"Mode         : {'APPLY (writes)' if APPLY else 'DRY-RUN (no writes)'}\n")

    if not os.path.exists(SQLITE_PATH):
        sys.exit(f"ERROR: SQLite not found: {SQLITE_PATH}")
    if not os.path.exists(DDL_PATH):
        sys.exit(f"ERROR: DDL not found: {DDL_PATH} (run gen_union_ddl.py first)")

    sq = sqlite3.connect(SQLITE_PATH)
    sq.row_factory = sqlite3.Row
    scur = sq.cursor()
    sqlite_tables = [
        r[0] for r in scur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
    ]

    pg = psycopg2.connect(PRIYA_PG_URL, connect_timeout=20)
    pg.autocommit = False

    # 1. Apply union DDL
    if APPLY:
        print("Creating tables (union DDL)...")
        with open(DDL_PATH) as f:
            ddl = f.read()
        with pg.cursor() as cur:
            cur.execute(ddl)
        pg.commit()
        print("  tables created.\n")
    else:
        print("[dry-run] would apply union DDL (51 tables)\n")

    pg_cols, pg_bools, pg_jsons = pg_schema(pg)

    # 2. Copy data table by table (column intersection)
    total = 0
    for t in sqlite_tables:
        if t not in pg_cols and not APPLY:
            # in dry-run PG tables may not exist yet; assume DDL would create them
            pass
        rows = scur.execute(f'SELECT * FROM "{t}"').fetchall()
        if not rows:
            print(f"  {t}: 0 rows (skip)")
            continue

        sqlite_columns = [d[0] for d in scur.description]
        target_cols = pg_cols.get(t)
        if target_cols is None and APPLY:
            print(f"  {t}: SKIP (no such PG table)")
            continue
        # column intersection
        use_cols = [c for c in sqlite_columns if (target_cols is None or c in target_cols)]
        dropped = [c for c in sqlite_columns if c not in use_cols]
        bools = pg_bools.get(t, set())
        jsons = pg_jsons.get(t, set())

        if not APPLY:
            print(f"  {t}: {len(rows)} rows; cols={len(use_cols)}"
                  + (f"; DROP {dropped}" if dropped else ""))
            total += len(rows)
            continue

        col_list = ", ".join(f'"{c}"' for c in use_cols)
        ph = ", ".join(["%s"] * len(use_cols))
        insert = f'INSERT INTO "{t}" ({col_list}) VALUES ({ph}) ON CONFLICT DO NOTHING'

        batch = []
        for row in rows:
            vals = []
            for c in use_cols:
                v = row[c]
                if c in bools and v is not None:
                    v = bool(v)
                elif c in jsons and v is not None and not isinstance(v, str):
                    v = json.dumps(v)
                vals.append(v)
            batch.append(vals)

        with pg.cursor() as cur:
            psycopg2.extras.execute_batch(cur, insert, batch, page_size=100)
        pg.commit()
        print(f"  {t}: {len(rows)} rows loaded"
              + (f"; dropped cols {dropped}" if dropped else ""))
        total += len(rows)

    # 3. Reset identity sequences
    if APPLY:
        print("\nResetting identity sequences...")
        with pg.cursor() as cur:
            for t in sqlite_tables:
                if t not in pg_cols or "id" not in pg_cols[t]:
                    continue
                try:
                    cur.execute(f'SELECT MAX(id) FROM "{t}"')
                    mx = cur.fetchone()[0]
                    if mx:
                        cur.execute(
                            "SELECT pg_get_serial_sequence(%s, 'id')", (t,)
                        )
                        seq = cur.fetchone()[0]
                        if seq:
                            cur.execute("SELECT setval(%s, %s)", (seq, mx))
                            print(f"  {t}: seq -> {mx}")
                    pg.commit()
                except Exception as e:
                    pg.rollback()
                    print(f"  {t}: seq reset failed: {str(e)[:80]}")

    sq.close()
    pg.close()
    print(f"\n{'Loaded' if APPLY else '[dry-run] would load'} ~{total} rows total.")


if __name__ == "__main__":
    main()
