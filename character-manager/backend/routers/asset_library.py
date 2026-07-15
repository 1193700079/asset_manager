import os
import urllib.request
from urllib.parse import quote

from fastapi import APIRouter
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from pydantic import BaseModel
from config import settings
from services import vfe_client
import time

router = APIRouter(prefix="/api/asset-library", tags=["asset-library"])

# Images root — same as VFE's IMAGES_ROOT
IMAGES_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "images")
)


class SkipRequest(BaseModel):
    path: str


# --- Cache layer: tag cloud changes rarely, no need to re-fetch every hit ---
# Keyed by material_type ("all"/"normal"/"spicy") so each library has its own cache.
_cache: dict[str, dict] = {}
_cache_ts: dict[str, float] = {}
CACHE_TTL = 300  # 5 minutes


def _normalize_tag(raw: str) -> str:
    if "|" in raw:
        parts = raw.split("|", 1)
        return f"{parts[0].strip()}|{parts[1].strip()}"
    return raw.strip()


async def _get_normalized_cloud(material_type: str | None = None) -> dict:
    key = material_type or "all"
    now = time.monotonic()
    if key in _cache and (now - _cache_ts.get(key, 0) < CACHE_TTL):
        return _cache[key]

    raw = await vfe_client.get_tag_cloud(material_type=material_type)
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
    _cache[key] = result
    _cache_ts[key] = now
    return result


@router.get("/tags")
async def get_tag_cloud(min_count: int = 2, material_type: str | None = None):
    """Return normalized tag cloud. min_count filters low-frequency tags.
    material_type ('normal'/'spicy') scopes to one asset library."""
    try:
        full = await _get_normalized_cloud(material_type)
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
async def get_dim_tags(dim: str, min_count: int = 1, material_type: str | None = None):
    """Lazy-load tags for a single dimension."""
    try:
        full = await _get_normalized_cloud(material_type)
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
    material_type: str | None = None,
):
    try:
        return await vfe_client.search_images(
            tag=tag, dimension=dimension,
            character_name=character_name,
            limit=limit, offset=offset,
            material_type=material_type,
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


_MIME_MAP = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".webp": "image/webp",
    ".gif": "image/gif", ".bmp": "image/bmp",
}


@router.get("/serve")
def serve_image(path: str, w: int = 0):
    """Proxy asset images from the VFE image service tunnel.

    ecjoy no longer has the files locally; VFE on ecs50 owns them, reachable
    only via the internal 18022 tunnel. We must PROXY the bytes (not 302) —
    the browser cannot reach ecjoy's localhost tunnel.
    """
    if not path or "\0" in path:
        return {"error": "bad_path"}
    cleaned = path.lstrip("/\\")
    if cleaned.startswith("..") or os.path.isabs(cleaned):
        return {"error": "forbidden"}
    url = settings.vfe_url.rstrip("/") + "/api/images/serve?path=" + quote(cleaned, safe="/")
    if w and w >= 32:
        url += f"&w={int(w)}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            data = r.read()
            ctype = r.headers.get("Content-Type", "image/jpeg")
    except Exception as e:
        return Response(content=f"upstream fetch failed: {e}", status_code=502)
    return Response(content=data, media_type=ctype,
                    headers={"Cache-Control": "public, max-age=86400"})
