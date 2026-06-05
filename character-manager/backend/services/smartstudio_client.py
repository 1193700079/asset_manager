import httpx
import asyncio
import logging
from config import settings

logger = logging.getLogger(__name__)

_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            base_url=settings.smartstudio_base_url,
            headers={
                "Authorization": f"Bearer {settings.smartstudio_api_key}",
                "Content-Type": "application/json",
            },
            timeout=60.0,
        )
    return _client


async def close_client():
    global _client
    if _client:
        await _client.aclose()
        _client = None


class SmartStudioError(Exception):
    def __init__(self, message: str, code: str = "", request_id: str = ""):
        self.code = code
        self.request_id = request_id
        super().__init__(message)


# Errors that are transient and should be retried
RETRYABLE_ERRORS = [
    "INPUT_DOWNLOAD_FAILED",
    "Service temporarily unavailable",
    "Internal server error",
    "Rate limit",
]


async def _submit(path: str, workflow_type: str, payload: dict, max_retries: int = 2) -> str:
    body = {
        "input": {
            "workflow_type": workflow_type,
            "payload": payload,
        },
    }

    logger.info(f"[SmartStudio] 提交任务: URL={settings.smartstudio_base_url}{path}, workflow_type={workflow_type}")

    last_error = None
    for attempt in range(max_retries + 1):
        # Create a fresh client for each attempt to avoid stale connection state
        client = httpx.AsyncClient(
            base_url=settings.smartstudio_base_url,
            headers={
                "Authorization": f"Bearer {settings.smartstudio_api_key}",
                "Content-Type": "application/json",
            },
            timeout=60.0,
        )
        try:
            resp = await client.post(path, json=body)
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            logger.error(f"[SmartStudio] HTTP错误: status={e.response.status_code}, attempt={attempt+1}/{max_retries+1}")
            await client.aclose()
            if attempt < max_retries:
                await asyncio.sleep(2)
                continue
            raise SmartStudioError(
                f"HTTP {e.response.status_code}: {e.response.text[:200]}",
                code=str(e.response.status_code),
            )
        except httpx.RequestError as e:
            logger.error(f"[SmartStudio] 网络错误: {e}, attempt={attempt+1}/{max_retries+1}")
            await client.aclose()
            if attempt < max_retries:
                await asyncio.sleep(2)
                continue
            raise SmartStudioError(f"网络错误: {str(e)[:200]}")
        finally:
            await client.aclose()

        data = resp.json()
        code = data.get("code", "")
        message = data.get("message", "")
        request_id = data.get("request_id", "")

        # Success codes: "200", "0", or empty
        if not code or str(code) in ("200", "0"):
            task_id = data.get("output", {}).get("task_id", "")
            if task_id:
                logger.info(f"[SmartStudio] 任务创建成功: task_id={task_id}, request_id={request_id}")
                return task_id
            last_error = SmartStudioError(
                "No task_id in response",
                request_id=request_id,
            )
            logger.warning(f"[SmartStudio] 响应中无task_id: {data}")
        else:
            # Check if this is a retryable error
            is_retryable = any(retry_msg in message for retry_msg in RETRYABLE_ERRORS + ["Unknown task type"])
            if is_retryable and attempt < max_retries:
                is_rate_limit = "Rate limit" in message
                backoff = (5 * (2 ** attempt)) if is_rate_limit else 2
                logger.warning(f"[SmartStudio] 可重试错误: {message}, attempt={attempt+1}/{max_retries+1}, 等待{backoff}s重试...")
                await asyncio.sleep(backoff)
                continue
            last_error = SmartStudioError(
                message or "Unknown error",
                code=str(code),
                request_id=request_id,
            )
            logger.error(f"[SmartStudio] 任务创建失败: code={code}, message={message}, request_id={request_id}")

    logger.error(f"[SmartStudio] 最终失败: {last_error}")
    raise last_error


async def create_faceswap(target_image: str, face_image: str, seed: int = 0) -> str:
    return await _submit(
        "/api/v2/services/aigc/ecosystem/faceswap/image-to-image",
        "faceswap",
        {"image": target_image, "face_image": face_image, "seed": seed},
    )


async def create_zimage(
    prompt: str, width: int = 1024, height: int = 1536, seed: int = 0
) -> str:
    return await _submit(
        "/api/v2/services/aigc/ecosystem/zimage-spicy/text-to-image",
        "zimage_spicy",
        {"prompt": prompt, "width": width, "height": height, "seed": seed},
    )


async def create_imageedit(
    image: str, prompt: str, seed: int = 0
) -> str:
    """QwenImageEdit Spicy — image editing via prompt (e.g. remove clothes, change outfit)."""
    return await _submit(
        "/api/v2/services/aigc/ecosystem/qwenimageedit-spicy/image-to-image",
        "qwenimageedit_spicy",
        {"image": image, "prompt": prompt, "seed": seed},
    )


async def create_wan_spicy(
    image: str,
    prompt: str,
    duration: int = 5,
    resolution: str = "480p",
    seed: int = 0,
) -> str:
    return await _submit(
        "/api/v2/services/aigc/ecosystem/wan-2.2-spicy/image-to-video",
        "wan22_spicy",
        {
            "image": image,
            "prompt": prompt,
            "duration": duration,
            "resolution": resolution,
            "seed": seed,
        },
    )


async def create_wan_animate(
    image: str,
    video: str,
    resolution: str = "480p",
    prompt: str = "",
    seed: int = 0,
) -> str:
    return await _submit(
        "/api/v2/services/aigc/alibaba/wan-2.2/animate",
        "wan22_animate",
        {
            "image": image,
            "video": video,
            "mode": "animate",
            "resolution": resolution,
            "prompt": prompt,
            "seed": seed,
        },
    )


async def poll_task(task_id: str) -> dict:
    # Create fresh client to avoid stale connection issues
    client = httpx.AsyncClient(
        base_url=settings.smartstudio_base_url,
        headers={
            "Authorization": f"Bearer {settings.smartstudio_api_key}",
            "Content-Type": "application/json",
        },
        timeout=60.0,
    )
    try:
        resp = await client.get(f"/api/v1/tasks/{task_id}")
        resp.raise_for_status()
        data = resp.json()
        return data.get("output", {})
    finally:
        await client.aclose()
