from fastapi import APIRouter
from pydantic import BaseModel
from services import vfe_client
import time

router = APIRouter(prefix="/api/asset-library", tags=["asset-library"])


class SkipRequest(BaseModel):
    path: str


# --- Cache layer: tag cloud changes rarely, no need to re-fetch every hit ---
_cache: dict | None = None
_cache_ts: float = 0
CACHE_TTL = 300  # 5 minutes


def _normalize_tag(raw: str) -> str:
    if "|" in raw:
        parts = raw.split("|", 1)
        return f"{parts[0].strip()}|{parts[1].strip()}"
    return raw.strip()


async def _get_normalized_cloud() -> dict:
    global _cache, _cache_ts
    now = time.monotonic()
    if _cache is not None and (now - _cache_ts < CACHE_TTL):
        return _cache

    raw = await vfe_client.get_tag_cloud()
    dims_raw = raw.get("dimensions", {})
    dims_clean: dict[str, list[dict]] = {}

    for dim_key, tags in dims_raw.items():
        merged: dict[str, int] = {}
        for t in tags:
            norm = _normalize_tag(t.get("tag", ""))
            if norm:
                merged[norm] = merged.get(norm, 0) + t.get("count", 0)
        tag_list = sorted(merged.items(), key=lambda x: x[1], reverse=True)
        dims_clean[dim_key] = [
            {"tag": t, "count": c} for t, c in tag_list
        ]

    result = {
        "total_images": raw.get("total_images", 0),
        "dimensions": dims_clean,
    }
    _cache = result
    _cache_ts = now
    return result


@router.get("/tags")
async def get_tag_cloud(min_count: int = 2):
    """Return normalized tag cloud. min_count filters low-frequency tags."""
    try:
        full = await _get_normalized_cloud()
        if min_count <= 1:
            return full
        trimmed = {
            d: [t for t in tags if t["count"] >= min_count]
            for d, tags in full["dimensions"].items()
        }
        return {
            "total_images": full["total_images"],
            "dimensions": trimmed,
            "_full_count": sum(len(v) for v in full["dimensions"].values()),
            "_shown_count": sum(len(v) for v in trimmed.values()),
        }
    except Exception as e:
        return {"total_images": 0, "dimensions": {}, "error": str(e)}


@router.get("/tags/{dim}")
async def get_dim_tags(dim: str, min_count: int = 1):
    """Lazy-load tags for a single dimension."""
    try:
        full = await _get_normalized_cloud()
        tags = full["dimensions"].get(dim, [])
        if min_count > 1:
            tags = [t for t in tags if t["count"] >= min_count]
        return {"dimension": dim, "total": len(tags), "tags": tags}
    except Exception as e:
        return {"dimension": dim, "total": 0, "tags": [], "error": str(e)}


@router.get("/images")
async def search_images(
    tag: str | None = None,
    dimension: str | None = None,
    character_name: str | None = None,
    limit: int = 50,
    offset: int = 0,
):
    try:
        return await vfe_client.search_images(
            tag=tag, dimension=dimension,
            character_name=character_name,
            limit=limit, offset=offset,
        )
    except Exception as e:
        return {"total": 0, "items": [], "error": str(e)}


@router.get("/stats")
async def get_stats():
    try:
        return await vfe_client.get_stats()
    except Exception as e:
        return {"total": 0, "characters": [], "top_tags": [], "error": str(e)}


@router.post("/skip")
async def skip_image(data: SkipRequest):
    try:
        return await vfe_client.skip_image(data.path)
    except Exception as e:
        return {"success": False, "error": str(e)}
