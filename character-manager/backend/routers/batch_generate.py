"""Batch character generation API.

Endpoints:
  POST /api/generation/characters
    body: {category, count, write_db}
    resp: {characters: [...], total, written: <int>}

  POST /api/generation/characters/save
    body: {characters: [{name, description, category, attributes}, ...]}
    resp: {total, written, skipped_duplicates}

The router shares its core logic with `services.character_generator` so that
the standalone CLI (`scripts/batch_generate_characters.py`) and this HTTP API
stay consistent.
"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from database import get_conn, put_conn
from services import character_generator as cg

router = APIRouter(prefix="/api/generation", tags=["generation"])

# generation_pools/ 位于 backend/ 下。素材池可由研究阶段产出后放入此目录。
BACKEND_DIR = Path(__file__).resolve().parent.parent
POOL_DIR = BACKEND_DIR / "generation_pools"

MAX_COUNT_PER_CALL = 20  # 单次接口建议上限，避免 AI 单次过长 / 超时


class GenerateCharactersRequest(BaseModel):
    category: str = Field(..., description="girlfriend/boyfriend/anime_female/anime_male")
    count: int = Field(10, ge=1, le=MAX_COUNT_PER_CALL)
    write_db: bool = Field(False, description="若为 true 则同时写入 ecjoy 数据库")
    batch_size: int = Field(8, ge=1, le=20,
                            description="每次 AI 请求生成数量")


class GeneratedCharacter(BaseModel):
    name: str
    category: str
    description: str
    attributes: dict


class GenerateCharactersResponse(BaseModel):
    characters: list[GeneratedCharacter]
    total: int
    written: int = 0
    skipped_duplicates: int = 0


def _fetch_existing_names() -> set[str]:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT name FROM characters")
            return {row[0] for row in cur.fetchall() if row and row[0]}
    finally:
        put_conn(conn)


def _fetch_existing_name_category_pairs() -> set[tuple[str, str]]:
    """读取已存在的 (name, category) 二元组，作为按名+分类去重的依据。"""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT name, category FROM characters WHERE name IS NOT NULL"
            )
            return {
                (row[0], row[1])
                for row in cur.fetchall()
                if row and row[0]
            }
    finally:
        put_conn(conn)


def _insert_characters(chars: list[dict]) -> int:
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
    conn = get_conn()
    try:
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
    finally:
        put_conn(conn)
    return inserted


@router.post("/characters", response_model=GenerateCharactersResponse)
def generate_characters(req: GenerateCharactersRequest) -> GenerateCharactersResponse:
    if req.category not in cg.VALID_CATEGORIES:
        raise HTTPException(
            400,
            detail=f"invalid category, must be one of {cg.VALID_CATEGORIES}",
        )

    # 1) 加载素材池（缺失时自动回退到内置默认）
    pools = cg.Pools.load(POOL_DIR if POOL_DIR.exists() else None)
    pool_slice = pools.slice_for(req.category)

    # 2) DashScope 客户端
    try:
        client = cg.build_qwen_client()
    except RuntimeError as e:
        raise HTTPException(500, detail=str(e))

    # 3) 已存在名字 (DB) 作为去重黑名单
    try:
        existing = _fetch_existing_names()
    except Exception:  # noqa: BLE001
        existing = set()

    # 4) 调用生成
    try:
        chars = cg.generate_for_category(
            client,
            category=req.category,
            count=req.count,
            batch_size=req.batch_size,
            pool_slice=pool_slice,
            avoid_names=set(existing),
            model=cg.DEFAULT_MODEL,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, detail=f"generation failed: {e}")

    # 5) 可选写入 DB
    written = 0
    skipped = 0
    if req.write_db and chars:
        # 二次过滤：避免在生成期间外部写入造成的并发冲突
        try:
            existing2 = _fetch_existing_names()
        except Exception:  # noqa: BLE001
            existing2 = set()
        to_insert = [c for c in chars if c["name"] not in existing2]
        skipped = len(chars) - len(to_insert)
        try:
            written = _insert_characters(to_insert)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(500, detail=f"db insert failed: {e}")

    return GenerateCharactersResponse(
        characters=[GeneratedCharacter(**c) for c in chars],
        total=len(chars),
        written=written,
        skipped_duplicates=skipped,
    )


# --- Save selected preview characters ---------------------------------------
class SaveCharacterItem(BaseModel):
    name: str
    description: str
    category: str
    attributes: dict


class SaveCharactersRequest(BaseModel):
    characters: list[SaveCharacterItem] = Field(..., min_length=1)


class SaveCharactersResponse(BaseModel):
    total: int
    written: int
    skipped_duplicates: int


@router.post("/characters/save", response_model=SaveCharactersResponse)
def save_characters(req: SaveCharactersRequest) -> SaveCharactersResponse:
    """将前端预览中用户选中的角色精确写入数据库。

    与 `POST /characters` 不同，这里不会再次调用 AI；仅校验入参后落库。
    """
    items: list[dict] = []
    for idx, c in enumerate(req.characters):
        if c.category not in cg.VALID_CATEGORIES:
            raise HTTPException(
                400,
                detail=(
                    f"item[{idx}] invalid category {c.category!r}, "
                    f"must be one of {cg.VALID_CATEGORIES}"
                ),
            )
        name = (c.name or "").strip()
        if not name:
            raise HTTPException(400, detail=f"item[{idx}] missing name")
        if len(name) > 64:
            raise HTTPException(
                400, detail=f"item[{idx}] name too long: {name!r}"
            )
        description = (c.description or "").strip()
        if not description:
            raise HTTPException(
                400, detail=f"item[{idx}] missing description"
            )
        if not isinstance(c.attributes, dict) or not c.attributes:
            raise HTTPException(
                400, detail=f"item[{idx}] attributes must be a non-empty object"
            )
        for k in cg.REQUIRED_ATTR_KEYS:
            v = c.attributes.get(k)
            if v is None or (isinstance(v, str) and not v.strip()):
                raise HTTPException(
                    400, detail=f"item[{idx}] attributes missing {k}"
                )
        items.append({
            "name": name,
            "category": c.category,
            "description": description,
            "attributes": c.attributes,
        })

    total = len(items)

    # 1) 预过滤：按 (name, category) 二元组排除已入库角色
    try:
        existing_pairs = _fetch_existing_name_category_pairs()
    except Exception:  # noqa: BLE001
        existing_pairs = set()

    to_insert = [
        c for c in items
        if (c["name"], c["category"]) not in existing_pairs
    ]
    skipped = total - len(to_insert)

    # 2) 批内重复（同次请求里 name+category 出现多次）只保留首次
    deduped: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for c in to_insert:
        key = (c["name"], c["category"])
        if key in seen:
            skipped += 1
            continue
        seen.add(key)
        deduped.append(c)

    # 3) 落库；ON CONFLICT DO NOTHING 兜底数据库已有的唯一约束
    try:
        written = _insert_characters(deduped)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, detail=f"db insert failed: {e}")

    # 写入数 < 计划数说明触发了数据库唯一约束，计入跳过
    if written < len(deduped):
        skipped += len(deduped) - written

    return SaveCharactersResponse(
        total=total,
        written=written,
        skipped_duplicates=skipped,
    )
