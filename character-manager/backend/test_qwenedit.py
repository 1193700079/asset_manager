import asyncio, sys
from database import init_pool, get_conn_for, put_conn_for
init_pool()
from services import batch_processing as bp

DS = "ecjoy"
N_CHARS = 4
N_PER = 3

def pick():
    c = get_conn_for(DS)
    try:
        cur = c.cursor()
        cur.execute("""SELECT id, name, avatar_url FROM characters
                       WHERE category='girlfriend' AND avatar_url IS NOT NULL AND avatar_url<>''
                         AND (is_deleted IS NULL OR is_deleted=FALSE)
                       ORDER BY random() LIMIT %s""", (N_CHARS,))
        chars = [{"id": r[0], "name": r[1], "avatar_url": r[2]} for r in cur.fetchall()]
        cur.execute("""SELECT prompt FROM saved_frames
                       WHERE prompt IS NOT NULL AND prompt<>'' AND (material_type='spicy' OR material_type IS NULL)
                       ORDER BY random() LIMIT %s""", (N_CHARS*N_PER,))
        prompts = [r[0] for r in cur.fetchall()]
        return chars, prompts
    finally:
        put_conn_for(DS, c)

async def main():
    chars, prompts = pick()
    print("TEST chars:", [c["name"] for c in chars], flush=True)
    pi = ok = fail = 0
    for ch in chars:
        for _ in range(N_PER):
            p = prompts[pi % len(prompts)]; pi += 1
            instr = ("Keep the same person's face and identity consistent. "
                     "Place this person in the following scene: " + p)
            unit = {"char": {"id": ch["id"], "name": ch["name"]}, "base": ch["avatar_url"], "prompt": instr}
            try:
                await bp._process_unit(DS, "imageedit", unit, 0, 1024, 1536, engine="qwenedit")
                ok += 1
                print("[OK] %s <- %s" % (ch["name"], p[:70]), flush=True)
            except Exception as e:
                fail += 1
                print("[FAIL] %s: %r" % (ch["name"], e), flush=True)
    print("DONE ok=%d fail=%d" % (ok, fail), flush=True)

asyncio.run(main())
