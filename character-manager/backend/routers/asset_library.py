from fastapi import APIRouter, Query
from pydantic import BaseModel
from services import vfe_client

router = APIRouter(prefix="/api/asset-library", tags=["asset-library"])


class SkipRequest(BaseModel):
    path: str


@router.get("/tags")
async def get_tag_cloud():
    try:
        return await vfe_client.get_tag_cloud()
    except Exception as e:
        return {"total_images": 0, "dimensions": {}, "error": str(e)}


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
