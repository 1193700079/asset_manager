"""Runtime-editable config for UI-toggleable integrations (stored in a JSON file,
so the frontend Settings page can flip them without a redeploy)."""
import json
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/config", tags=["config"])

CONFIG_PATH = Path(__file__).resolve().parent.parent / "runtime_config.json"

MODELARK_DEFAULTS = {
    "enabled": False,
    "api_key": "",            # ark-... bearer key (inference / video gen only)
    "endpoint_id": "",
    "base_url": "https://ark.ap-southeast.bytepluses.com/api/v3",
    # AK/SK for the Assets API (素材库/OpenAPI signature) — different auth from api_key
    "access_key_id": "",
    "secret_access_key": "",
    "host": "open.byteplusapi.com",
    "region": "ap-southeast-1",
    "moderation_skip": False,   # 跳过内容预过滤(成人素材用; 需先在控制台关预过滤)
    "project": "default",       # ModelArk 项目(ProjectName); 项目间资产隔离
}


def _load() -> dict:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text())
        except Exception:
            return {}
    return {}


def _save(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2, ensure_ascii=False))


def get_modelark_config() -> dict:
    """Helper for other modules (e.g. the export/push route)."""
    cfg = _load().get("modelark") or {}
    return {**MODELARK_DEFAULTS, **cfg}


class ModelArkConfig(BaseModel):
    enabled: bool = False
    api_key: str = ""
    endpoint_id: str = ""
    base_url: str = "https://ark.ap-southeast.bytepluses.com/api/v3"
    access_key_id: str = ""
    secret_access_key: str = ""
    host: str = "open.byteplusapi.com"
    region: str = "ap-southeast-1"
    moderation_skip: bool = False
    project: str = "default"


@router.get("/modelark")
async def read_modelark():
    return {"status": "ok", "config": get_modelark_config()}


@router.put("/modelark")
async def write_modelark(data: ModelArkConfig):
    cfg = _load()
    groups = (cfg.get("modelark") or {}).get("groups") or {}  # 保留角色→组映射
    merged = data.model_dump()
    if groups:
        merged["groups"] = groups
    cfg["modelark"] = merged
    _save(cfg)
    return {"status": "ok", "config": cfg["modelark"]}
