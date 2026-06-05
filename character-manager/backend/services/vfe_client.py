import httpx
from config import settings

_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(base_url=settings.vfe_url, timeout=30.0)
    return _client


async def close_client():
    global _client
    if _client:
        await _client.aclose()
        _client = None


async def search_images(
    tag: str | None = None,
    dimension: str | None = None,
    character_name: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict:
    client = get_client()
    params: dict = {"limit": limit, "offset": offset}
    if tag:
        params["tag"] = tag
    if dimension:
        params["dimension"] = dimension
    if character_name:
        params["character_name"] = character_name
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
