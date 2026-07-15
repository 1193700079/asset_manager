"""File-upload face-swap client for the vps141 ComfyUI wrapper.

The vps141 8020 API is now an async task queue: POST returns {task_id, PENDING},
poll GET /v1/tasks/{id} until SUCCEEDED. It also requires a Bearer API key.
Backward-compatible with the old synchronous {images:[...]} response."""
import asyncio

import aiohttp

from config import settings

# ecjoy reaches vps141's localhost:8020 through an SSH tunnel.
DEFAULT_URL = "http://127.0.0.1:18021"
PUBLIC_HOST = "http://45.207.197.141:8020"

_RETRY_EXC = (aiohttp.ClientConnectorError, aiohttp.ServerDisconnectedError,
              aiohttp.ClientOSError, aiohttp.ClientPayloadError)


def _base() -> str:
    return getattr(settings, "faceswap_url", DEFAULT_URL).rstrip("/")


def _auth() -> dict:
    return {"Authorization": f"Bearer {getattr(settings, 'comfy_api_key', '')}"}


async def _read_url(session: aiohttp.ClientSession, url: str) -> tuple[bytes, str]:
    async with session.get(url, timeout=aiohttp.ClientTimeout(total=60)) as r:
        if r.status != 200:
            raise RuntimeError(f"download failed HTTP {r.status}: {url[:160]}")
        ctype = r.headers.get("Content-Type") or "application/octet-stream"
        data = await r.read()
        if not data:
            raise RuntimeError(f"download empty: {url[:160]}")
        return data, ctype.split(";")[0]


async def _poll_task(session: aiohttp.ClientSession, task_id: str, timeout_sec: int) -> str:
    """Poll GET /v1/tasks/{id} until SUCCEEDED; return first image url."""
    deadline = asyncio.get_event_loop().time() + timeout_sec
    while asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(2)
        try:
            async with session.get(f"{_base()}/v1/tasks/{task_id}", headers=_auth(),
                                   timeout=aiohttp.ClientTimeout(total=20)) as r:
                if r.status != 200:
                    continue
                t = await r.json()
        except _RETRY_EXC:
            continue
        st = t.get("status")
        if st == "SUCCEEDED":
            imgs = t.get("images") or []
            if not imgs or not imgs[0].get("url"):
                raise RuntimeError(f"faceswap succeeded but no image: {str(t)[:200]}")
            return imgs[0]["url"].replace(PUBLIC_HOST, _base())
        if st == "FAILED":
            raise RuntimeError(f"faceswap task failed: {t.get('error')}")
    raise RuntimeError(f"faceswap task timed out after {timeout_sec}s")


async def face_swap(body_url: str, face_url: str, prompt: str = "", seed: int = 0, timeout_sec: int = 300) -> str:
    async with aiohttp.ClientSession() as s:
        body, body_type = await _read_url(s, body_url)
        face, face_type = await _read_url(s, face_url)

        form = aiohttp.FormData()
        form.add_field("body", body, filename="body.png", content_type=body_type)
        form.add_field("face", face, filename="face.png", content_type=face_type)
        if prompt:
            form.add_field("prompt", prompt)
        if seed:
            form.add_field("seed", str(int(seed)))
        form.add_field("timeout_sec", str(int(timeout_sec)))
        form.add_field("debug", "0")

        async with s.post(f"{_base()}/v1/face-swap", data=form, headers=_auth(),
                          timeout=aiohttp.ClientTimeout(total=120)) as r:
            text = await r.text()
            if r.status != 200:
                raise RuntimeError(f"faceswap HTTP {r.status}: {text[:300]}")
            out = await r.json()

        # sync response (old API) or async task (new API)
        images = out.get("images") or []
        if images and images[0].get("url"):
            return images[0]["url"].replace(PUBLIC_HOST, _base())
        task_id = out.get("task_id")
        if task_id:
            return await _poll_task(s, task_id, timeout_sec)
        raise RuntimeError(f"faceswap returned no images/task: {str(out)[:300]}")
