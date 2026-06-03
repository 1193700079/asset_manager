"""Batch-generate avatars for ALL characters in both data sources (YOLO face crop)."""
import json
import sys
import time

sys.path.insert(0, "/mnt/cypher/project/asset_manager/character-manager/backend")

import psycopg2
import psycopg2.extras
from config import settings
from services import avatar


def first_image(media):
    if isinstance(media, str):
        try:
            media = json.loads(media)
        except (json.JSONDecodeError, TypeError):
            media = []
    media = media or []
    return next(
        (m["url"] for m in media
         if isinstance(m, dict) and m.get("type") == "image"
         and m.get("url") and not m.get("is_deleted")),
        None,
    )


def run(ds_name, url, only_missing=True):
    conn = psycopg2.connect(url, connect_timeout=20)
    conn.autocommit = True
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    q = """SELECT id, name, media, avatar_url FROM characters
           WHERE (is_deleted IS NULL OR is_deleted = FALSE)"""
    if only_missing:
        q += " AND (avatar_url IS NULL OR avatar_url = '')"
    q += " ORDER BY name"
    cur.execute(q)
    rows = cur.fetchall()

    total = len(rows)
    ok = fail = no_img = 0
    print(f"\n[{ds_name}] {total} characters to process (only_missing={only_missing})", flush=True)
    t0 = time.time()
    for i, r in enumerate(rows, 1):
        img = first_image(r["media"])
        if not img:
            no_img += 1
            continue
        res = avatar.generate_avatar(img)
        if res.get("ok"):
            cur.execute("UPDATE characters SET avatar_url=%s WHERE id=%s",
                        (res["avatar_url"], r["id"]))
            ok += 1
        else:
            fail += 1
            print(f"  FAIL {r['name']}: {res.get('error')}", flush=True)
        if i % 25 == 0:
            el = time.time() - t0
            print(f"  [{ds_name}] {i}/{total}  ok={ok} fail={fail} no_img={no_img}  "
                  f"({el:.0f}s, {el/i:.2f}s/char)", flush=True)
    conn.close()
    print(f"[{ds_name}] DONE ok={ok} fail={fail} no_img={no_img} "
          f"in {time.time()-t0:.0f}s", flush=True)
    return ok, fail, no_img


if __name__ == "__main__":
    only_missing = "--all" not in sys.argv
    for name, url in settings.datasources.items():
        run(name, url, only_missing=only_missing)
    print("\nALL DONE", flush=True)
