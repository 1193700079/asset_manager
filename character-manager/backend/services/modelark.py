"""BytePlus ModelArk private virtual portrait library (素材库) client.

The Assets API (CreateAssetGroup / CreateAsset / GetAsset / ListAssets ...) is a
volc "universal" top-level OpenAPI signed with AK/SK (Signature V4), NOT the
ark-... bearer key (that one only authorizes inference / video generation).

Docs: https://docs.byteplus.com/en/docs/ModelArk/2333565
"""
import hashlib
import hmac
import json
from datetime import datetime, timezone
from urllib import request as urlrequest, error as urlerror

from routers.config import get_modelark_config

SERVICE = "ark"
API_VERSION = "2024-01-01"


def _project() -> str:
    return get_modelark_config().get("project") or "default"


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _signed_call(action: str, body: dict) -> dict:
    """Sign and POST one universal OpenAPI action. Returns parsed JSON Result
    (raises RuntimeError on API error)."""
    cfg = get_modelark_config()
    ak = cfg.get("access_key_id", "")
    sk = cfg.get("secret_access_key", "")
    host = cfg.get("host", "open.byteplusapi.com")
    region = cfg.get("region", "ap-southeast-1")
    if not ak or not sk:
        raise RuntimeError("ModelArk AK/SK 未配置 (runtime_config.json modelark.access_key_id/secret_access_key)")

    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    now = datetime.now(timezone.utc)
    x_date = now.strftime("%Y%m%dT%H%M%SZ")
    short_date = now.strftime("%Y%m%d")
    payload_hash = _sha256_hex(payload)

    canonical_query = f"Action={action}&Version={API_VERSION}"
    signed_headers = "content-type;host;x-content-sha256;x-date"
    canonical_headers = (
        "content-type:application/json\n"
        f"host:{host}\n"
        f"x-content-sha256:{payload_hash}\n"
        f"x-date:{x_date}\n"
    )
    canonical_request = "\n".join([
        "POST", "/", canonical_query, canonical_headers, signed_headers, payload_hash,
    ])

    credential_scope = f"{short_date}/{region}/{SERVICE}/request"
    string_to_sign = "\n".join([
        "HMAC-SHA256", x_date, credential_scope, _sha256_hex(canonical_request.encode("utf-8")),
    ])

    k_date = _hmac(sk.encode("utf-8"), short_date)
    k_region = _hmac(k_date, region)
    k_service = _hmac(k_region, SERVICE)
    k_signing = _hmac(k_service, "request")
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    authorization = (
        f"HMAC-SHA256 Credential={ak}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    url = f"https://{host}/?{canonical_query}"
    req = urlrequest.Request(url, data=payload, method="POST", headers={
        "Content-Type": "application/json",
        "Host": host,
        "X-Date": x_date,
        "X-Content-Sha256": payload_hash,
        "Authorization": authorization,
    })
    try:
        with urlrequest.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except urlerror.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")
        raise RuntimeError(f"ModelArk {action} HTTP {e.code}: {detail}")

    meta = data.get("ResponseMetadata", {})
    if meta.get("Error"):
        raise RuntimeError(f"ModelArk {action} error: {meta['Error']}")
    return data.get("Result", data)


# ── High-level ops ────────────────────────────────────────────────────────────

def list_asset_groups(name: str = "", group_type: str = "AIGC") -> dict:
    flt: dict = {"GroupType": group_type}
    if name:
        flt["Name"] = name
    return _signed_call("ListAssetGroups", {"Filter": flt, "PageNumber": 1, "PageSize": 50})


def create_asset_group(name: str, description: str = "", project: str = "") -> str:
    r = _signed_call("CreateAssetGroup", {
        "Name": name, "Description": description or name, "ProjectName": project or _project(),
    })
    return r["Id"]


def create_asset(group_id: str, url: str, asset_type: str = "Image",
                 name: str = "", project: str = "") -> str:
    body = {"GroupId": group_id, "URL": url, "AssetType": asset_type, "ProjectName": project or _project()}
    if name:
        body["Name"] = name
    # 成人/敏感素材: 默认内容预过滤会拦 (InputImageSensitiveContentDetected)。
    # 开 moderation_skip 后跳过 (前提: 控制台已关内容预过滤)。
    if get_modelark_config().get("moderation_skip"):
        body["Moderation"] = {"Strategy": "Skip"}
    r = _signed_call("CreateAsset", body)
    return r["Id"]


def get_asset(asset_id: str, project: str = "") -> dict:
    return _signed_call("GetAsset", {"Id": asset_id, "ProjectName": project or _project()})


def delete_asset(asset_id: str, project: str = "") -> None:
    _signed_call("DeleteAsset", {"Id": asset_id, "ProjectName": project or _project()})


def delete_asset_group(group_id: str, project: str = "") -> None:
    _signed_call("DeleteAssetGroup", {"Id": group_id, "ProjectName": project or _project()})


def push_images(character_name: str, urls: list, asset_type: str = "Image") -> dict:
    """Push a batch of image URLs into the character's asset group. Creates all
    assets first (fast), then polls the pending ones a few rounds so images that
    preprocess quickly report Active without a long per-image wait."""
    import time
    gid = ensure_group(character_name)
    created = []
    for u in urls:
        try:
            aid = create_asset(gid, u, asset_type)
            created.append({"url": u, "asset_id": aid, "status": "Processing", "ok": True})
        except Exception as e:
            created.append({"url": u, "asset_id": None, "status": "error", "ok": False, "error": str(e)[:200]})
    pending = [c for c in created if c["asset_id"] and c["status"] not in ("Active", "Failed")]
    for _ in range(4):
        if not pending:
            break
        time.sleep(3)
        for c in pending:
            try:
                c["status"] = get_asset(c["asset_id"]).get("Status", "Processing")
                c["ok"] = c["status"] != "Failed"
            except Exception:
                pass
        pending = [c for c in pending if c["status"] not in ("Active", "Failed")]
    return {"group_id": gid, "results": created}


def ensure_group(character_name: str) -> str:
    """Return an existing asset group id for this character (matched by exact
    Name), else create one. Cached back into runtime_config.json."""
    from routers.config import _load, _save
    project = _project()
    key = f"{project}::{character_name}"   # 组缓存按项目隔离(项目间资产不通用)
    cfg = _load()
    groups = (cfg.get("modelark") or {}).get("groups") or {}
    if key in groups:
        return groups[key]
    # try to find an existing same-name group IN THIS PROJECT before creating
    gid = ""
    try:
        items = list_asset_groups(name=character_name).get("Items", [])
        for it in items:
            if it.get("Name") == character_name and it.get("ProjectName") == project:
                gid = it["Id"]
                break
    except Exception:
        pass
    if not gid:
        gid = create_asset_group(character_name)
    cfg.setdefault("modelark", {}).setdefault("groups", {})[key] = gid
    _save(cfg)
    return gid
