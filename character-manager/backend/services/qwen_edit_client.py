"""Client for the image-edit API. Now targets the ecs50/A100 ComfyUI edit
service (POST /v1/qwen-image-edit) reached through the SSH tunnel
(systemd qwen-edit-tunnel: 127.0.0.1:18020 -> ecs50:8020 api,
 127.0.0.1:18188 -> ecs50:8188 comfy /view for result fetch)."""
import asyncio

import aiohttp

from config import settings

# A100 returns result urls on its own ComfyUI /view (127.0.0.1:8188);
# rewrite that host to the local view tunnel so we can fetch it from ecjoy.
# ponytail: hardcoded tunnel ports match qwen-edit-tunnel.service; make settings if they ever move.
VIEW_LOCAL = "http://127.0.0.1:8188"
VIEW_TUNNEL = "http://127.0.0.1:18188"

# The SSH tunnel occasionally drops and systemd reconnects within a few seconds;
# during that window the local port refuses connections. Retry connection-class
# failures so a transient reconnect doesn't lose the image. Real model errors
# (HTTP 4xx/5xx, timeouts) are NOT retried — they propagate as failures.
_RETRY_EXC = (
    aiohttp.ClientConnectorError,
    aiohttp.ServerDisconnectedError,
    aiohttp.ClientOSError,
    aiohttp.ClientPayloadError,
)
_MAX_ATTEMPTS = 4
_RETRY_WAIT = 6  # seconds; > tunnel RestartSec so the port is back before we retry


def _base() -> str:
    return getattr(settings, "qwen_edit_url", "http://127.0.0.1:18020").rstrip("/")


async def edit_image(image_url: str, prompt: str, seed: int = 0, timeout_sec: int = 600) -> str:
    """Download the base image, submit a multipart edit request to the A100
    ComfyUI edit API, and return the result URL rewritten to go through the
    view tunnel so _persist_url can fetch it. Retries connection-class failures
    (transient tunnel reconnects)."""
    base = _base()
    async with aiohttp.ClientSession() as s:
        async with s.get(image_url, timeout=aiohttp.ClientTimeout(total=60)) as r:
            if r.status != 200:
                raise RuntimeError(f"qwen-edit base image download failed HTTP {r.status}")
            img = await r.read()

        out = None
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            form = aiohttp.FormData()  # rebuilt each attempt (FormData is single-use)
            form.add_field("image", img, filename="input.png", content_type="image/png")
            form.add_field("prompt", prompt)
            if seed:
                form.add_field("seed", str(int(seed)))
            form.add_field("timeout_sec", str(timeout_sec))
            try:
                async with s.post(f"{base}/v1/qwen-image-edit", data=form,
                                  timeout=aiohttp.ClientTimeout(total=timeout_sec + 40)) as r:
                    if r.status != 200:
                        raise RuntimeError(f"qwen-edit HTTP {r.status}: {(await r.text())[:200]}")
                    out = await r.json()
                break
            except _RETRY_EXC as e:
                if attempt >= _MAX_ATTEMPTS:
                    raise RuntimeError(
                        f"qwen-edit connection failed after {attempt} attempts (tunnel down?): {e!r}"
                    ) from e
                await asyncio.sleep(_RETRY_WAIT)

    images = out.get("images") or []
    if not images or not images[0].get("url"):
        raise RuntimeError(f"qwen-edit returned no images: {str(out)[:200]}")
    return images[0]["url"].replace(VIEW_LOCAL, VIEW_TUNNEL)
