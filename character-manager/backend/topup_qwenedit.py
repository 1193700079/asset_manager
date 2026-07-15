import asyncio
from database import init_pool, get_conn_for, put_conn_for
init_pool()
from services import batch_processing as bp

DS = "ecjoy"
TARGETS = [("Mia Rossi", 3), ("Isabella Vega", 1)]

def load():
    c = get_conn_for(DS)
    try:
        cur = c.cursor()
        names = [t[0] for t in TARGETS]
        cur.execute("SELECT id, name, avatar_url FROM characters WHERE name = ANY(%s)", (names,))
        chars = {r[1]: {"id": r[0], "name": r[1], "avatar_url": r[2]} for r in cur.fetchall()}
        total = sum(n for _, n in TARGETS)
        cur.execute("""SELECT prompt FROM saved_frames
                       WHERE prompt IS NOT NULL AND prompt<>'' AND (material_type='spicy' OR material_type IS NULL)
                       ORDER BY random() LIMIT %s""", (total,))
        prompts = [r[0] for r in cur.fetchall()]
        return chars, prompts
    finally:
        put_conn_for(DS, c)

async def main():
    chars, prompts = load()
    pi = ok = fail = 0
    for name, cnt in TARGETS:
        ch = chars.get(name)
        if not ch or not ch.get("avatar_url"):
            print("[SKIP] %s (no avatar)" % name, flush=True); continue
        for _ in range(cnt):
            p = prompts[pi % len(prompts)]; pi += 1
            instr = ("Keep the same person's face and identity consistent. "
                     "Place this person in the following scene: " + p)
            unit = {"char": {"id": ch["id"], "name": name}, "base": ch["avatar_url"], "prompt": instr}
            try:
                await bp._process_unit(DS, "imageedit", unit, 0, 1024, 1536, engine="qwenedit")
                ok += 1; print("[OK] %s <- %s" % (name, p[:60]), flush=True)
            except Exception as e:
                fail += 1; print("[FAIL] %s: %r" % (name, e), flush=True)
    print("TOPUP DONE ok=%d fail=%d" % (ok, fail), flush=True)

asyncio.run(main())
