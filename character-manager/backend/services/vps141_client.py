"""Client for vps141 Pro6000 ComfyUI API (text-to-image / image-edit / avatar).

The vps141 8020 API is an async task queue: POST returns {task_id, PENDING},
poll GET /v1/tasks/{id} until SUCCEEDED. Requires a Bearer API key. Reached from
ecjoy through the SSH tunnel 127.0.0.1:18021 -> vps141:8020. Backward-compatible
with the old synchronous {images:[...]} response."""
import asyncio

import aiohttp

from config import settings

DEFAULT_URL = "http://127.0.0.1:18021"
PUBLIC_HOST = "http://45.207.197.141:8020"

_RETRY_EXC = (aiohttp.ClientConnectorError, aiohttp.ServerDisconnectedError,
              aiohttp.ClientOSError, aiohttp.ClientPayloadError)


def _base() -> str:
    return getattr(settings, "vps141_url", DEFAULT_URL).rstrip("/")


def _auth() -> dict:
    return {"Authorization": f"Bearer {getattr(settings, 'comfy_api_key', '')}"}


def _rewrite(url: str) -> str:
    return url.replace(PUBLIC_HOST, _base())


async def _read_url(session: aiohttp.ClientSession, url: str) -> tuple[bytes, str]:
    async with session.get(url, timeout=aiohttp.ClientTimeout(total=60)) as r:
        if r.status != 200:
            raise RuntimeError(f"download failed HTTP {r.status}: {url[:160]}")
        data = await r.read()
        if not data:
            raise RuntimeError(f"download empty: {url[:160]}")
        return data, (r.headers.get("Content-Type") or "image/png").split(";")[0]


async def _poll_task(session, task_id: str, what: str, timeout_sec: int) -> str:
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
                raise RuntimeError(f"{what} succeeded but no image: {str(t)[:200]}")
            return _rewrite(imgs[0]["url"])
        if st == "FAILED":
            raise RuntimeError(f"{what} task failed: {t.get('error')}")
    raise RuntimeError(f"{what} task timed out after {timeout_sec}s")


async def _result(session, out: dict, what: str, timeout_sec: int) -> str:
    images = out.get("images") or []
    if images and images[0].get("url"):
        return _rewrite(images[0]["url"])
    task_id = out.get("task_id")
    if task_id:
        return await _poll_task(session, task_id, what, timeout_sec)
    raise RuntimeError(f"{what} returned no images/task: {str(out)[:200]}")


async def text_to_image(prompt: str, seed: int = 0, width: int = 1024,
                        height: int = 1536, steps: int = 12, timeout_sec: int = 300) -> str:
    payload = {"prompt": prompt, "width": width, "height": height, "steps": steps, "timeout_sec": timeout_sec}
    if seed:
        payload["seed"] = int(seed)
    async with aiohttp.ClientSession() as s:
        async with s.post(f"{_base()}/v1/text-to-image", json=payload, headers=_auth(),
                          timeout=aiohttp.ClientTimeout(total=120)) as r:
            text = await r.text()
            if r.status != 200:
                raise RuntimeError(f"t2i HTTP {r.status}: {text[:300]}")
            out = await r.json()
        return await _result(s, out, "t2i", timeout_sec)


async def image_edit(image_url: str, prompt: str, seed: int = 0, timeout_sec: int = 300) -> str:
    async with aiohttp.ClientSession() as s:
        img, ctype = await _read_url(s, image_url)
        form = aiohttp.FormData()
        form.add_field("image", img, filename="input.png", content_type=ctype)
        form.add_field("prompt", prompt)
        if seed:
            form.add_field("seed", str(int(seed)))
        form.add_field("timeout_sec", str(int(timeout_sec)))
        async with s.post(f"{_base()}/v1/qwen-image-edit", data=form, headers=_auth(),
                          timeout=aiohttp.ClientTimeout(total=120)) as r:
            text = await r.text()
            if r.status != 200:
                raise RuntimeError(f"image-edit HTTP {r.status}: {text[:300]}")
            out = await r.json()
        return await _result(s, out, "image-edit", timeout_sec)


async def avatar(image_url: str, timeout_sec: int = 120) -> str:
    async with aiohttp.ClientSession() as s:
        img, ctype = await _read_url(s, image_url)
        form = aiohttp.FormData()
        form.add_field("image", img, filename="input.png", content_type=ctype)
        async with s.post(f"{_base()}/v1/avatar", data=form, headers=_auth(),
                          timeout=aiohttp.ClientTimeout(total=60)) as r:
            text = await r.text()
            if r.status != 200:
                raise RuntimeError(f"avatar HTTP {r.status}: {text[:300]}")
            out = await r.json()
        return await _result(s, out, "avatar", timeout_sec)
