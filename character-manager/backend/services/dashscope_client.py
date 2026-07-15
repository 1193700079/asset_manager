"""DashScope (百炼) wanx 2.6 text-to-image client for batch zimage generation."""
import uuid
import tempfile
from pathlib import Path

import httpx

from config import settings
from services.comfyui_single import _upload_to_oss

DASHSCOPE_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
MODEL = "wan2.6-image"


async def create_zimage(prompt: str, width: int = 1024, height: int = 1536, seed: int = 0) -> str:
    """Generate an image via wanx 2.6 sync API, download the result, upload to
    OSS, and return the permanent public URL.

    Raises RuntimeError on any failure.
    """
    if not settings.dashscope_api_key:
        raise RuntimeError("DASHSCOPE_API_KEY not configured")

    size = f"{width}*{height}"
    payload = {
        "model": MODEL,
        "input": {
            "messages": [{
                "role": "user",
                "content": [{"text": prompt}],
            }],
        },
        "parameters": {
            "enable_interleave": True,
            "size": size,
            "n": 1,
            "prompt_extend": True,
            "watermark": False,
        },
    }
    if seed and seed > 0:
        payload["parameters"]["seed"] = seed

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings.dashscope_api_key}",
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(DASHSCOPE_URL, json=payload, headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f"DashScope HTTP {resp.status_code}: {resp.text[:300]}")
        data = resp.json()

    choices = data.get("output", {}).get("choices", [])
    if not choices:
        err = data.get("message") or data.get("code") or str(data)[:300]
        raise RuntimeError(f"DashScope error: {err}")

    image_url = None
    for item in choices[0].get("message", {}).get("content", []):
        if isinstance(item, dict) and item.get("image"):
            image_url = item["image"]
            break

    if not image_url:
        raise RuntimeError("DashScope returned no image URL")

    job_id = uuid.uuid4().hex[:12]
    async with httpx.AsyncClient(timeout=60.0) as client:
        img_resp = await client.get(image_url)
        if img_resp.status_code != 200:
            raise RuntimeError(f"Failed to download DashScope image: HTTP {img_resp.status_code}")

    tmp_dir = Path(tempfile.gettempdir()) / "dashscope_downloads"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = tmp_dir / f"{job_id}.png"
    tmp_path.write_bytes(img_resp.content)

    public_url = _upload_to_oss(str(tmp_path), f"dashscope_{job_id}")
    tmp_path.unlink(missing_ok=True)

    if not public_url:
        raise RuntimeError("DashScope image generated but OSS upload failed")

    return public_url


QWEN_VL_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
QWEN_VL_MODEL = "qwen3.7-plus"

VIDEO_PROMPT_SYSTEM = """You are a video motion prompt generator. Given a portrait/character image, describe a short (5-second) video clip motion that would make this person come alive naturally.

Rules:
- Describe ONLY the motion/action, not the person's appearance
- Keep it under 2 sentences, concise and specific
- Focus on subtle natural movements: facial expressions, gaze shifts, hair/clothing movement, posture changes
- Include lighting/atmosphere cues if relevant
- Output in English only
- Do NOT include any thinking tags or reasoning, just the prompt directly"""


async def generate_video_prompt(image_url: str) -> str:
    """Use qwen3.7-plus vision model to analyze an image and generate a video motion prompt."""
    if not settings.dashscope_api_key:
        raise RuntimeError("DASHSCOPE_API_KEY not configured")

    payload = {
        "model": QWEN_VL_MODEL,
        "messages": [
            {"role": "system", "content": VIDEO_PROMPT_SYSTEM},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": image_url}},
                    {"type": "text", "text": "Generate a video motion prompt for this character image."},
                ],
            },
        ],
        "max_tokens": 150,
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings.dashscope_api_key}",
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(QWEN_VL_URL, json=payload, headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f"Qwen VL HTTP {resp.status_code}: {resp.text[:300]}")
        data = resp.json()

    choices = data.get("choices", [])
    if not choices:
        raise RuntimeError(f"Qwen VL returned no choices: {data.get('error', data)}")

    content = choices[0].get("message", {}).get("content", "")
    # Strip any <think>...</think> tags if present
    import re
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()

    if not content:
        return "The person smiles gently, shifts their gaze naturally, with subtle head movement and soft hair sway. Cinematic, natural lighting."

    return content


FACESWAP_QA_SYSTEM = """You are an image quality inspector for AI face-swap results.
Judge only whether the face matches the body naturally.
Reject if there is obvious face/body skin tone mismatch, black head with white body, white head with dark body, unnatural face boundary, pasted face, wrong lighting/color between face and body, or severe face artifacts.
Return strict JSON only: {"ok": true|false, "reason": "short reason", "fix_prompt": "short edit prompt if not ok"}.
"""


async def judge_faceswap_quality(image_url: str) -> dict:
    """Use qwen3.7-plus VL to detect bad face/body mismatch."""
    if not settings.dashscope_api_key:
        return {"ok": True, "reason": "DASHSCOPE_API_KEY not configured", "fix_prompt": ""}

    payload = {
        "model": QWEN_VL_MODEL,
        "messages": [
            {"role": "system", "content": FACESWAP_QA_SYSTEM},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": image_url}},
                    {"type": "text", "text": "Check this face-swap image. Is the face/body skin tone and lighting consistent?"},
                ],
            },
        ],
        "max_tokens": 180,
        "response_format": {"type": "json_object"},
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings.dashscope_api_key}",
    }
    async with httpx.AsyncClient(timeout=45.0) as client:
        resp = await client.post(QWEN_VL_URL, json=payload, headers=headers)
        if resp.status_code != 200:
            return {"ok": True, "reason": f"judge skipped HTTP {resp.status_code}", "fix_prompt": ""}
        data = resp.json()
    content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
    import json as _json, re
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
    try:
        out = _json.loads(content)
    except Exception:
        return {"ok": True, "reason": "judge parse skipped", "fix_prompt": ""}
    return {
        "ok": bool(out.get("ok", True)),
        "reason": str(out.get("reason") or "")[:300],
        "fix_prompt": str(out.get("fix_prompt") or "Blend the face naturally with the body; match skin tone, lighting, color temperature, and face boundary.")[:500],
    }
