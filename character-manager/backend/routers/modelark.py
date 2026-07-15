"""Push selected images into the BytePlus ModelArk private virtual portrait
library (素材库). One asset group per character."""
from fastapi import APIRouter, Request
from pydantic import BaseModel

from routers.config import get_modelark_config
from services import modelark, auth

router = APIRouter(prefix="/api/modelark", tags=["modelark"])


class PushRequest(BaseModel):
    character_name: str
    urls: list[str]
    asset_type: str = "Image"


@router.get("/status")
async def status():
    cfg = get_modelark_config()
    return {
        "enabled": bool(cfg.get("enabled")),
        "has_keys": bool(cfg.get("access_key_id") and cfg.get("secret_access_key")),
    }


@router.post("/push")
async def push(data: PushRequest, request: Request):
    user = auth.user_from_request(request)
    cfg = get_modelark_config()
    if not cfg.get("enabled"):
        return {"status": "error", "message": "ModelArk 未启用（在 Settings 里开启）"}
    if not cfg.get("access_key_id") or not cfg.get("secret_access_key"):
        return {"status": "error", "message": "ModelArk AK/SK 未配置"}
    if not data.urls:
        return {"status": "error", "message": "没有选中图片"}
    try:
        r = modelark.push_images(data.character_name, data.urls, data.asset_type)
        auth.log_action(user, "modelark-push", data.character_name)
        return {"status": "ok", **r}
    except Exception as e:
        return {"status": "error", "message": str(e)[:300]}
