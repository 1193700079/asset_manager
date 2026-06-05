#!/usr/bin/env python3
"""
Migrate local ComfyUI results to OSS.
Updates both the job records and character media arrays.
"""
import json
import oss2
from pathlib import Path
from config import settings
from database import init_pool, get_conn, put_conn
import psycopg2.extras

# Initialize database connection pool
init_pool()

OUTPUT_DIR = Path(__file__).parent / "logs" / "comfyui_output"

conn = get_conn()
cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

# Find all characters with local ComfyUI URLs in media
cur.execute("SELECT id, name, media FROM characters")
rows = cur.fetchall()

auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)
bucket = oss2.Bucket(auth, settings.oss_endpoint, settings.oss_bucket)
endpoint = settings.oss_endpoint.replace("https://", "").replace("http://", "")

uploaded = 0
failed = 0
updated_chars = []

for row in rows:
    char_id = row["id"]
    char_name = row["name"]
    media_raw = row["media"]
    
    if isinstance(media_raw, str):
        try:
            media_list = json.loads(media_raw)
        except:
            continue
    elif isinstance(media_raw, list):
        media_list = media_raw
    else:
        continue
    
    if not media_list:
        continue
    
    changed = False
    for item in media_list:
        if not isinstance(item, dict):
            continue
        
        url = item.get("url", "")
        if url.startswith("/api/comfyui/result/"):
            # Extract job_id and filename from URL
            parts = url.replace("/api/comfyui/result/", "").split("/")
            if len(parts) >= 2:
                job_id = parts[0]
                filename = "/".join(parts[1:])
                local_path = OUTPUT_DIR / job_id / filename
                
                if local_path.exists():
                    try:
                        oss_key = f"{settings.oss_prefix}{job_id}/{filename}"
                        bucket.put_object_from_file(oss_key, str(local_path))
                        oss_url = f"https://{settings.oss_bucket}.{endpoint}/{oss_key}"
                        
                        print(f"✓ {char_name}: {filename} -> OSS")
                        item["url"] = oss_url
                        changed = True
                        uploaded += 1
                    except Exception as e:
                        print(f"✗ {char_name}: {filename} failed: {e}")
                        failed += 1
                else:
                    print(f"⚠ {char_name}: {filename} not found locally")
                    failed += 1
    
    if changed:
        cur.execute(
            "UPDATE characters SET media = %s::json WHERE id = %s",
            (json.dumps(media_list), char_id)
        )
        updated_chars.append(char_name)

conn.commit()
cur.close()
put_conn(conn)

print(f"\n完成: {uploaded} 个文件上传到 OSS, {failed} 个失败, 更新了 {len(updated_chars)} 个角色")
if updated_chars:
    print(f"更新的角色: {', '.join(updated_chars)}")
