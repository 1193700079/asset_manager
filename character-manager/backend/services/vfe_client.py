import asyncio

import httpx
from config import settings

# Cache one AsyncClient per event loop. Sharing a single httpx.AsyncClient
# across event loops (e.g. the FastAPI loop and a batch worker's private loop)
# leaks closed-loop transports and surfaces as "Event loop is closed" on the
# next call from any other loop. Per-loop caching plus a weak-ref keyed by the
# loop id makes the client lifecycle line up with the loop that owns it.
_clients: dict[int, httpx.AsyncClient] = {}


def _loop_key() -> int:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = asyncio.get_event_loop()
    return id(loop)


def get_client() -> httpx.AsyncClient:
    key = _loop_key()
    client = _clients.get(key)
    if client is None or client.is_closed:
        client = httpx.AsyncClient(base_url=settings.vfe_url, timeout=30.0)
        _clients[key] = client
    return client


async def close_client():
    """Close the AsyncClient tied to the current loop. Called by the FastAPI
    lifespan and by batch workers before they tear their loop down."""
    key = _loop_key()
    client = _clients.pop(key, None)
    if client and not client.is_closed:
        await client.aclose()


async def search_images(
    tag: str | None = None,
    dimension: str | None = None,
    character_name: str | None = None,
    limit: int = 50,
    offset: int = 0,
    order: str | None = None,
) -> dict:
    client = get_client()
    params: dict = {"limit": limit, "offset": offset}
    if tag:
        params["tag"] = tag
    if dimension:
        params["dimension"] = dimension
    if character_name:
        params["character_name"] = character_name
    if order:
        params["order"] = order
    resp = await client.get("/api/swapface/search", params=params)
    resp.raise_for_status()
    return resp.json()


async def get_faceswap_materials(limit: int = 10) -> dict:
    """Random face_nsfw prescreened images used as faceswap body material."""
    client = get_client()
    resp = await client.get("/api/swapface/materials", params={"limit": limit})
    resp.raise_for_status()
    return resp.json()


async def get_video_prompts(limit: int = 10) -> dict:
    """Random records with video_prompt + a first-frame image."""
    client = get_client()
    resp = await client.get("/api/swapface/video-prompts", params={"limit": limit})
    resp.raise_for_status()
    return resp.json()


async def get_tag_cloud() -> dict:
    client = get_client()
    resp = await client.get("/api/swapface/tag-cloud")
    resp.raise_for_status()
    return resp.json()


async def get_stats() -> dict:
    client = get_client()
    resp = await client.get("/api/swapface/stats")
    resp.raise_for_status()
    return resp.json()


async def skip_image(path: str) -> dict:
    client = get_client()
    resp = await client.post("/api/image/skip", json={"path": path})
    resp.raise_for_status()
    return resp.json()


async def ping(timeout: float = 3.0) -> dict:
    """Cheap liveness check against VFE /api/health. Used by callers that want
    to fail-fast (e.g. CM batch faceswap) instead of producing dozens of
    connection-refused errors when the VFE backend is down.

    Returns {"ok": True} on success or {"ok": False, "error": "..."} otherwise.
    """
    try:
        # Don't reuse the long-lived AsyncClient — we want a tight timeout.
        async with httpx.AsyncClient(base_url=settings.vfe_url, timeout=timeout) as client:
            resp = await client.get("/api/health")
            if resp.status_code == 200:
                return {"ok": True}
            return {"ok": False, "error": f"VFE /api/health -> HTTP {resp.status_code}"}
    except Exception as e:
        return {"ok": False, "error": f"VFE 不可达 ({settings.vfe_url}): {type(e).__name__}: {e}"}
