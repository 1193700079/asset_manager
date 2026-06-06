"""批量生成角色脚本 (CLI)。

使用 DashScope OpenAI 兼容接口调用 `qwen3-235b-a22b` 模型批量生成角色。
默认仅输出到 JSON 文件供人工审核；`--write-db` 才写库。

核心生成逻辑位于 `services.character_generator`，与 HTTP API
(POST /api/generation/characters) 共享，保证两端一致。

使用示例：
    # dry-run，每类生成 5 个，仅打印（不写文件、不写库）
    python batch_generate_characters.py --category girlfriend --count 5 --dry-run

    # 生成全部 4 类各 50 个，写到 generated_characters/<cat>.json
    python batch_generate_characters.py --category all --count 50

    # 审核完毕，从已生成 JSON 写入数据库
    python batch_generate_characters.py --from-file ./generated_characters --write-db

    # 一步生成 + 写库
    python batch_generate_characters.py --category all --count 50 --write-db
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Iterable

# --- 路径与配置加载 -----------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(BACKEND_DIR))

try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv(BACKEND_DIR / ".env")
except Exception:
    pass

from config import settings  # noqa: E402
from services import character_generator as cg  # noqa: E402

DEFAULT_OUTPUT_DIR = SCRIPT_DIR / "generated_characters"
# 与后端 API 共享同一个素材池目录
DEFAULT_POOL_DIR = BACKEND_DIR / "generation_pools"


# --- DB 工具 ------------------------------------------------------------------
def fetch_existing_names(dsn: str) -> set[str]:
    import psycopg2
    with psycopg2.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT name FROM characters")
            return {row[0] for row in cur.fetchall() if row[0]}


def insert_characters(dsn: str, chars: list[dict]) -> int:
    import psycopg2
    sql = """
        INSERT INTO characters (
            name, category, description, attributes,
            character_status, creator_id
        )
        VALUES (%s, %s, %s, %s::jsonb, 'pending', 'official')
        ON CONFLICT DO NOTHING
        RETURNING id
    """
    inserted = 0
    with psycopg2.connect(dsn) as conn:
        with conn.cursor() as cur:
            for c in chars:
                cur.execute(sql, (
                    c["name"],
                    c["category"],
                    c["description"],
                    json.dumps(c["attributes"], ensure_ascii=False),
                ))
                if cur.fetchone():
                    inserted += 1
        conn.commit()
    return inserted


# --- 文件 I/O -----------------------------------------------------------------
def write_json_output(output_dir: Path, category: str, chars: list[dict]) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    fp = output_dir / f"{category}.json"
    fp.write_text(json.dumps(chars, ensure_ascii=False, indent=2),
                  encoding="utf-8")
    return fp


def load_json_dir(input_dir: Path,
                  categories: Iterable[str]) -> dict[str, list[dict]]:
    result: dict[str, list[dict]] = {}
    for cat in categories:
        fp = input_dir / f"{cat}.json"
        if not fp.exists():
            print(f"[from-file] missing {fp}, skip {cat}")
            continue
        result[cat] = json.loads(fp.read_text(encoding="utf-8"))
    return result


# --- CLI ----------------------------------------------------------------------
def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="批量生成角色 (Qwen3-235B-A22B)")
    p.add_argument("--category", default="all",
                   choices=("all", *cg.VALID_CATEGORIES))
    p.add_argument("--count", type=int, default=50,
                   help="每个分类生成数量 (默认 50)")
    p.add_argument("--batch-size", type=int, default=8)
    p.add_argument("--model", default=cg.DEFAULT_MODEL)
    p.add_argument("--base-url", default=cg.DEFAULT_BASE_URL)
    p.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    p.add_argument("--pool-dir", type=Path, default=DEFAULT_POOL_DIR)
    p.add_argument("--write-db", action="store_true",
                   help="生成后写入 ecjoy 数据库 (默认仅写 JSON)")
    p.add_argument("--from-file", type=Path, default=None,
                   help="跳过 AI，从该目录读 JSON 直接写库 (需 --write-db)")
    p.add_argument("--dry-run", action="store_true",
                   help="只打印结果，不写文件也不写库")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    cats = (list(cg.VALID_CATEGORIES)
            if args.category == "all" else [args.category])

    # 路径 A: --from-file 跳过 AI，直接写库
    if args.from_file is not None:
        if not args.write_db:
            raise SystemExit("--from-file requires --write-db")
        all_chars = load_json_dir(args.from_file, cats)
        existing = fetch_existing_names(settings.ecjoy_database_url)
        total_in = 0
        for cat, chars in all_chars.items():
            kept = [c for c in chars if c.get("name") not in existing]
            print(f"[db] {cat}: {len(kept)}/{len(chars)} ready "
                  f"(filtered {len(chars) - len(kept)} duplicates)")
            n = insert_characters(settings.ecjoy_database_url, kept)
            print(f"[db] {cat}: inserted {n}")
            total_in += n
        print(f"\nDone. Total inserted: {total_in}.")
        return

    # 路径 B: 调用 AI 生成
    pools = cg.Pools.load(args.pool_dir if args.pool_dir.exists() else None)
    client = cg.build_qwen_client(base_url=args.base_url)

    try:
        existing = fetch_existing_names(settings.ecjoy_database_url)
        print(f"[db] {len(existing)} existing names will be deduped against")
    except Exception as e:  # noqa: BLE001
        print(f"[db] could not fetch existing names ({e}), skipping dedupe")
        existing = set()

    summary: dict[str, int] = {}
    for cat in cats:
        print(f"\n=== Generating {cat} (count={args.count}) ===")
        slice_ = pools.slice_for(cat)
        if not any(slice_.values()):
            print(f"[warn] pool empty for {cat} (using built-in fallback)")

        def _on_progress(evt: dict) -> None:
            if evt.get("event") == "progress":
                print(f"  [{evt['category']}] {evt['done']}/{evt['total']}")
            elif evt.get("event") == "batch_failed":
                print(f"  [batch failed] {evt.get('error')}")

        chars = cg.generate_for_category(
            client,
            category=cat,
            count=args.count,
            batch_size=args.batch_size,
            pool_slice=slice_,
            avoid_names=set(existing),
            model=args.model,
            on_progress=_on_progress,
        )
        for c in chars:
            existing.add(c["name"])
        summary[cat] = len(chars)

        if args.dry_run:
            print(json.dumps(chars[:3], ensure_ascii=False, indent=2))
            print(f"[dry-run] {cat}: {len(chars)} generated, not persisted")
            continue

        fp = write_json_output(args.output_dir, cat, chars)
        print(f"[file] wrote {fp} ({len(chars)} characters)")

        if args.write_db:
            n = insert_characters(settings.ecjoy_database_url, chars)
            print(f"[db] {cat}: inserted {n}")

    print("\n=== Summary ===")
    for cat, n in summary.items():
        print(f"  {cat}: {n}")


if __name__ == "__main__":
    main()
