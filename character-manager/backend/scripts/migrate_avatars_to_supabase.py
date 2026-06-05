"""Migrate existing local avatars to Supabase Storage and update database URLs."""
import asyncio
import sys
from pathlib import Path

# Add parent to path so we can import project modules
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx
from config import settings
from database import init_pool, get_conn, put_conn

SUPABASE_URL = settings.supabase_url
SERVICE_ROLE_KEY = settings.supabase_service_role_key
BUCKET = "avatars"
AVATAR_DIR = Path(__file__).resolve().parent.parent / "logs" / "avatars"


def _headers():
    return {
        "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
        "apikey": SERVICE_ROLE_KEY,
    }


async def ensure_bucket():
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(
            f"{SUPABASE_URL}/storage/v1/bucket/{BUCKET}", headers=_headers()
        )
        if r.status_code == 200:
            print(f"Bucket '{BUCKET}' already exists.")
            return
        r = await client.post(
            f"{SUPABASE_URL}/storage/v1/bucket",
            headers=_headers(),
            json={"id": BUCKET, "name": BUCKET, "public": True},
        )
        r.raise_for_status()
        print(f"Created bucket '{BUCKET}'.")


async def upload_file(
    client: httpx.AsyncClient, filepath: Path, sem: asyncio.Semaphore
):
    async with sem:
        filename = filepath.name
        headers = _headers()
        headers["Content-Type"] = "image/png"
        headers["x-upsert"] = "true"

        data = filepath.read_bytes()
        r = await client.post(
            f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{filename}",
            headers=headers,
            content=data,
        )
        if r.status_code in (200, 201):
            return filename, True
        else:
            print(f"  FAILED {filename}: {r.status_code} {r.text[:200]}")
            return filename, False


async def migrate_files():
    files = list(AVATAR_DIR.glob("*.png"))
    total = len(files)
    print(f"Found {total} avatar files to migrate.")

    if total == 0:
        return 0

    sem = asyncio.Semaphore(8)  # max 8 concurrent uploads
    success = 0
    failed = 0

    async with httpx.AsyncClient(timeout=60.0) as client:
        tasks = [upload_file(client, f, sem) for f in files]
        for coro in asyncio.as_completed(tasks):
            filename, ok = await coro
            if ok:
                success += 1
            else:
                failed += 1
            if (success + failed) % 50 == 0:
                print(
                    f"  Progress: {success + failed}/{total} "
                    f"(success={success}, failed={failed})"
                )

    print(f"\nUpload complete: {success} success, {failed} failed out of {total}")
    return success


def update_database():
    """Update avatar_url in database from relative paths to full Supabase URLs."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, avatar_url FROM characters "
                "WHERE avatar_url LIKE '/api/avatar/file/%'"
            )
            rows = cur.fetchall()
            print(f"\nFound {len(rows)} database records to update.")

            updated = 0
            for char_id, old_url in rows:
                filename = old_url.split("/")[-1]
                new_url = (
                    f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{filename}"
                )
                cur.execute(
                    "UPDATE characters SET avatar_url = %s WHERE id = %s",
                    (new_url, char_id),
                )
                updated += 1

            conn.commit()
            print(f"Updated {updated} database records.")
    finally:
        put_conn(conn)


async def main():
    print("=== Avatar Migration to Supabase Storage ===\n")

    # Initialize database pool
    init_pool()

    # Step 1: Ensure bucket exists
    await ensure_bucket()

    # Step 2: Upload all local avatar files
    await migrate_files()

    # Step 3: Update database URLs
    update_database()

    print("\n=== Migration Complete ===")


if __name__ == "__main__":
    asyncio.run(main())
