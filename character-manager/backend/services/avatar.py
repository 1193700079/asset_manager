"""Avatar generation: detect the main face and crop a centered square portrait.

Uses a YOLO face-detection model (yolov8m-face) for detection. The detected
face box is expanded by a margin and cropped to a centered square, then resized
and uploaded to Supabase Storage.
"""
import threading
import uuid
from io import BytesIO
from pathlib import Path

import numpy as np
import requests
from PIL import Image

from services.supabase_storage import upload_avatar

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "logs" / "avatars"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

WEIGHTS = Path(__file__).resolve().parent.parent / "models" / "weights" / "yolov8m-face.pt"

OUT_SIZE = 512          # final square avatar size (px)
MARGIN = 0.6            # expand face box by this fraction on each side
CONF = 0.25            # YOLO detection confidence threshold

_model = None
_model_lock = threading.Lock()


def _get_model():
    """Lazy-load the YOLO face model (heavy; load once)."""
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from ultralytics import YOLO

                _model = YOLO(str(WEIGHTS))
    return _model


def _load_image(image_url: str) -> Image.Image:
    if image_url.startswith("http://") or image_url.startswith("https://"):
        resp = requests.get(image_url, timeout=30)
        resp.raise_for_status()
        return Image.open(BytesIO(resp.content)).convert("RGB")
    p = Path(image_url)
    if p.exists():
        return Image.open(p).convert("RGB")
    raise FileNotFoundError(f"Image not accessible: {image_url}")


def _largest_face_box(img: Image.Image):
    """Return (x1, y1, x2, y2) of the largest detected face, or None."""
    model = _get_model()
    result = model.predict(np.asarray(img), verbose=False, conf=CONF)[0]
    boxes = result.boxes
    if boxes is None or len(boxes) == 0:
        return None
    best = None
    best_area = -1.0
    for b in boxes:
        x1, y1, x2, y2 = (float(v) for v in b.xyxy[0])
        area = (x2 - x1) * (y2 - y1)
        if area > best_area:
            best_area = area
            best = (x1, y1, x2, y2)
    return best


def _centered_square_crop(img: Image.Image, box) -> Image.Image:
    """Crop a centered square around the face box, expanded by MARGIN."""
    w, h = img.size
    x1, y1, x2, y2 = box
    cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
    face_w, face_h = x2 - x1, y2 - y1
    # square side based on the larger face dimension, expanded by margin
    side = max(face_w, face_h) * (1.0 + 2.0 * MARGIN)
    side = min(side, w, h)  # cannot exceed image bounds
    half = side / 2.0

    # keep the crop window inside the image while staying centered on the face
    left = cx - half
    top = cy - half
    left = max(0, min(left, w - side))
    top = max(0, min(top, h - side))
    crop = img.crop((int(left), int(top), int(left + side), int(top + side)))
    return crop.resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)


def _center_crop_fallback(img: Image.Image) -> Image.Image:
    """No face found: center-crop a square from the image."""
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    crop = img.crop((left, top, left + side, top + side))
    return crop.resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)


async def generate_avatar(image_url: str) -> dict:
    """Detect face, crop centered square, upload to Supabase Storage.

    Tries the vps141 Pro6000 GPU YOLO endpoint first; falls back to local YOLO
    if it is unreachable. Returns {ok, avatar_url, face_found, filename}.
    """
    # --- vps141 Pro6000 GPU path (preferred) ---
    try:
        from services import vps141_client
        import uuid as _uuid
        crop_url = await vps141_client.avatar(image_url)
        import aiohttp as _aio
        async with _aio.ClientSession() as _s:
            async with _s.get(crop_url, timeout=_aio.ClientTimeout(total=60)) as _r:
                if _r.status == 200:
                    _bytes = await _r.read()
                    _fn = f"{_uuid.uuid4().hex}.png"
                    (OUTPUT_DIR / _fn).write_bytes(_bytes)
                    try:
                        _url = await upload_avatar(_bytes, _fn)
                    except Exception:
                        _url = f"/api/avatar/file/{_fn}"
                    return {"ok": True, "avatar_url": _url, "face_found": True, "filename": _fn}
    except Exception as _e:
        print(f"[avatar] vps141 path failed, falling back to local YOLO: {_e}")

    try:
        img = _load_image(image_url)
    except Exception as e:
        return {"ok": False, "error": f"load failed: {e}"}

    try:
        box = _largest_face_box(img)
        face_found = box is not None
        out = _centered_square_crop(img, box) if box else _center_crop_fallback(img)
    except Exception as e:
        return {"ok": False, "error": f"detect/crop failed: {e}"}

    filename = f"{uuid.uuid4().hex}.png"

    # Save to bytes for upload
    buf = BytesIO()
    out.save(buf, format="PNG")
    img_bytes = buf.getvalue()

    # Also save locally as backup
    out.save(OUTPUT_DIR / filename, format="PNG")

    # Upload to Supabase Storage
    try:
        public_url = await upload_avatar(img_bytes, filename)
    except Exception as e:
        # Fallback to local URL if upload fails
        return {
            "ok": True,
            "avatar_url": f"/api/avatar/file/{filename}",
            "face_found": face_found,
            "filename": filename,
        }

    return {
        "ok": True,
        "avatar_url": public_url,
        "face_found": face_found,
        "filename": filename,
    }


def get_avatar_file(filename: str):
    """Return local path for a saved avatar, or None if missing/invalid."""
    if "/" in filename or "\\" in filename or ".." in filename:
        return None
    path = OUTPUT_DIR / filename
    return str(path) if path.exists() else None
