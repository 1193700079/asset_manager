"""Supabase Storage client using httpx REST API."""
import httpx
from config import settings

SUPABASE_URL = settings.supabase_url
SERVICE_ROLE_KEY = settings.supabase_service_role_key
BUCKET = "avatars"


def _headers():
    return {
        "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
        "apikey": SERVICE_ROLE_KEY,
    }


async def ensure_bucket_exists():
    """Create the avatars bucket if it doesn't exist (public)."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(
            f"{SUPABASE_URL}/storage/v1/bucket/{BUCKET}", headers=_headers()
        )
        if r.status_code == 200:
            return  # already exists
        # Create it
        r = await client.post(
            f"{SUPABASE_URL}/storage/v1/bucket",
            headers=_headers(),
            json={"id": BUCKET, "name": BUCKET, "public": True},
        )
        r.raise_for_status()


async def upload_avatar(file_bytes: bytes, filename: str) -> str:
    """Upload PNG bytes to Supabase Storage and return the public URL."""
    headers = _headers()
    headers["Content-Type"] = "image/png"
    headers["x-upsert"] = "true"

    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(
            f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{filename}",
            headers=headers,
            content=file_bytes,
        )
        r.raise_for_status()

    return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{filename}"
