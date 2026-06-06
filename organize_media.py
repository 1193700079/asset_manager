# #!/usr/bin/env python3
# """
# Media Organizer - Scans /mnt/data and copies audio/video/image files
# into the project's audio/, videos/, images/ directories.

# Structure:
#   images/{source_tag}/{original_filename}
#   videos/{source_tag}/{original_filename}
#   audio/{source_tag}/{original_filename}

# Handles collisions by appending a short hash.
# Resumable - skips already-copied files (checks size match).
# """

# import os
# import sys
# import shutil
# import hashlib
# import json
# import time
# from pathlib import Path
# from concurrent.futures import ThreadPoolExecutor, as_completed
# from collections import defaultdict

# # === CONFIG ===
# SOURCE_DIR = Path("/mnt/data")
# PROJECT_DIR = Path("/mnt/cypher/project/asset_manager")
# TARGET_DIRS = {
#     "image": PROJECT_DIR / "images",
#     "video": PROJECT_DIR / "videos",
#     "audio": PROJECT_DIR / "audio",
# }
# LOG_FILE = PROJECT_DIR / "organize_media_log.json"
# DRY_RUN = "--dry-run" in sys.argv
# NUM_WORKERS = 8  # parallel copy threads

# # === EXTENSIONS ===
# VIDEO_EXTS = {
#     ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm",
#     ".m4v", ".ts", ".rmvb", ".rm", ".mpg", ".mpeg", ".3gp", ".vob",
# }
# AUDIO_EXTS = {
#     ".mp3", ".flac", ".wav", ".aac", ".ogg", ".wma", ".m4a",
#     ".opus", ".ape", ".mid", ".midi", ".aiff",
# }
# IMAGE_EXTS = {
#     ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg",
#     ".tiff", ".tif", ".ico", ".psd", ".raw", ".cr2", ".nef",
# }


# def classify(ext: str) -> str | None:
#     ext_lower = ext.lower()
#     if ext_lower in VIDEO_EXTS:
#         return "video"
#     if ext_lower in AUDIO_EXTS:
#         return "audio"
#     if ext_lower in IMAGE_EXTS:
#         return "image"
#     return None


# def extract_source_tag(filepath: Path) -> str:
#     """Extract a meaningful source tag from the path relative to /mnt/data.
#     Uses the first 1-2 meaningful directory levels as a tag."""
#     rel = filepath.relative_to(SOURCE_DIR)
#     parts = rel.parts[:-1]  # drop filename

#     if not parts:
#         return "root"

#     # For "Pack From Shared/XXX YYY/..." use the second level
#     if parts[0] == "Pack From Shared" and len(parts) >= 2:
#         tag = parts[1].strip()
#         # Truncate very long names
#         if len(tag) > 80:
#             tag = tag[:77] + "..."
#         return sanitize_dirname(tag)

#     # For baiducloud/... use first two levels
#     if parts[0] == "baiducloud" and len(parts) >= 2:
#         # collapse deep paths
#         if len(parts) >= 3:
#             tag = f"{parts[1][:40]}_{parts[2][:40]}"
#         else:
#             tag = parts[1][:80]
#         return sanitize_dirname(tag)

#     # For quarkpan/...
#     if parts[0] == "quarkpan" and len(parts) >= 2:
#         tag = parts[1][:80]
#         return sanitize_dirname(tag)

#     # Fallback: use first directory
#     tag = parts[0][:80]
#     return sanitize_dirname(tag)


# def sanitize_dirname(name: str) -> str:
#     """Remove problematic characters from directory name."""
#     # Replace path-unfriendly chars
#     for ch in ['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\x00']:
#         name = name.replace(ch, '_')
#     # Strip leading/trailing spaces and dots
#     name = name.strip(' .')
#     return name or "untagged"


# def file_hash_short(filepath: Path) -> str:
#     """Quick hash using filename + size for collision detection."""
#     stat = filepath.stat()
#     raw = f"{filepath.name}:{stat.st_size}:{filepath.parent}"
#     return hashlib.md5(raw.encode()).hexdigest()[:8]


# def build_target_path(src_file: Path, media_type: str) -> Path:
#     """Build the destination path, handling collisions."""
#     target_base = TARGET_DIRS[media_type]
#     source_tag = extract_source_tag(src_file)
#     target_dir = target_base / source_tag
#     target_file = target_dir / src_file.name

#     # Handle collision: if file exists but different size, append hash
#     if target_file.exists():
#         existing_size = target_file.stat().st_size
#         src_size = src_file.stat().st_size
#         if existing_size == src_size:
#             return target_file  # same file, skip
#         # Different file, same name -> add hash
#         stem = src_file.stem
#         suffix = src_file.suffix
#         h = file_hash_short(src_file)
#         target_file = target_dir / f"{stem}_{h}{suffix}"

#     return target_file


# def copy_file(src: Path, dst: Path) -> dict:
#     """Copy a single file with result tracking."""
#     result = {
#         "src": str(src),
#         "dst": str(dst),
#         "status": "ok",
#         "size": 0,
#         "skipped": False,
#     }

#     try:
#         src_size = src.stat().st_size
#         result["size"] = src_size

#         # Skip if already copied (same size)
#         if dst.exists():
#             dst_size = dst.stat().st_size
#             if dst_size == src_size:
#                 result["skipped"] = True
#                 result["status"] = "skip_same_size"
#                 return result

#         if DRY_RUN:
#             result["status"] = "dry_run"
#             return result

#         # Create parent dir
#         dst.parent.mkdir(parents=True, exist_ok=True)

#         # Copy file (preserving metadata)
#         shutil.copy2(str(src), str(dst))

#         # Verify
#         if dst.exists() and dst.stat().st_size == src_size:
#             result["status"] = "copied"
#         else:
#             result["status"] = "verify_failed"

#     except PermissionError as e:
#         result["status"] = f"permission_error: {e}"
#     except OSError as e:
#         result["status"] = f"os_error: {e}"
#     except Exception as e:
#         result["status"] = f"error: {e}"

#     return result


# def scan_source() -> list[tuple[Path, str]]:
#     """Walk /mnt/data and classify all media files."""
#     media_files = []
#     total_scanned = 0

#     for root, dirs, files in os.walk(SOURCE_DIR):
#         for fname in files:
#             total_scanned += 1
#             ext = os.path.splitext(fname)[1]
#             media_type = classify(ext)
#             if media_type:
#                 media_files.append((Path(root) / fname, media_type))

#     print(f"  Scanned {total_scanned} total files, found {len(media_files)} media files")
#     return media_files


# def run():
#     print("=" * 60)
#     print("  MEDIA ORGANIZER")
#     print(f"  Source: {SOURCE_DIR}")
#     print(f"  Target: {PROJECT_DIR}")
#     print(f"  Dry Run: {DRY_RUN}")
#     print(f"  Workers: {NUM_WORKERS}")
#     print("=" * 60)

#     # Create target dirs
#     for media_type, target_dir in TARGET_DIRS.items():
#         target_dir.mkdir(parents=True, exist_ok=True)
#         print(f"  [{media_type}] -> {target_dir}")

#     # Scan
#     print("\n[1/3] Scanning source directory...")
#     t0 = time.time()
#     media_files = scan_source()
#     scan_time = time.time() - t0
#     print(f"  Scan took {scan_time:.1f}s")

#     # Stats
#     counts = defaultdict(int)
#     sizes = defaultdict(int)
#     for fpath, mtype in media_files:
#         counts[mtype] += 1
#         try:
#             sizes[mtype] += fpath.stat().st_size
#         except:
#             pass

#     print("\n  Summary:")
#     for mtype in ["image", "video", "audio"]:
#         sz_gb = sizes[mtype] / (1024**3)
#         print(f"    {mtype:6s}: {counts[mtype]:>6d} files, {sz_gb:.1f} GB")

#     total_files = sum(counts.values())
#     total_gb = sum(sizes.values()) / (1024**3)
#     print(f"    {'TOTAL':6s}: {total_files:>6d} files, {total_gb:.1f} GB")

#     # Copy
#     print(f"\n[2/3] Copying files ({'DRY RUN' if DRY_RUN else 'LIVE'})...")
#     t1 = time.time()

#     results = []
#     copied = 0
#     skipped = 0
#     errors = 0

#     with ThreadPoolExecutor(max_workers=NUM_WORKERS) as executor:
#         futures = {}
#         for src_file, media_type in media_files:
#             target = build_target_path(src_file, media_type)
#             future = executor.submit(copy_file, src_file, target)
#             futures[future] = (src_file, media_type)

#         total = len(futures)
#         done = 0
#         for future in as_completed(futures):
#             done += 1
#             result = future.result()
#             results.append(result)

#             if result.get("skipped"):
#                 skipped += 1
#             elif result["status"] in ("copied", "dry_run"):
#                 copied += 1
#             else:
#                 errors += 1

#             # Progress every 500 files
#             if done % 500 == 0 or done == total:
#                 elapsed = time.time() - t1
#                 rate = done / elapsed if elapsed > 0 else 0
#                 pct = done / total * 100
#                 print(f"  [{done}/{total}] {pct:.0f}% | "
#                       f"copied={copied} skip={skipped} err={errors} | "
#                       f"{rate:.0f} files/s", flush=True)

#     copy_time = time.time() - t1

#     # Report
#     print(f"\n[3/3] Results:")
#     print(f"  Total time: {copy_time:.1f}s")
#     print(f"  Copied: {copied}")
#     print(f"  Skipped: {skipped}")
#     print(f"  Errors: {errors}")

#     # Log errors
#     error_results = [r for r in results if not r.get("skipped") and r["status"] not in ("copied", "dry_run", "skip_same_size")]
#     if error_results:
#         print(f"\n  Error details ({len(error_results)}):")
#         for r in error_results[:20]:
#             print(f"    {r['src']}: {r['status']}")
#         if len(error_results) > 20:
#             print(f"    ... and {len(error_results) - 20} more")

#     # Save full log
#     log_data = {
#         "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
#         "source": str(SOURCE_DIR),
#         "dry_run": DRY_RUN,
#         "summary": {
#             "total_found": total_files,
#             "copied": copied,
#             "skipped": skipped,
#             "errors": errors,
#             "scan_time_s": round(scan_time, 1),
#             "copy_time_s": round(copy_time, 1),
#         },
#         "by_type": {
#             mtype: {"count": counts[mtype], "size_gb": round(sizes[mtype] / (1024**3), 2)}
#             for mtype in ["image", "video", "audio"]
#         },
#         "errors": error_results,
#     }

#     if not DRY_RUN:
#         with open(LOG_FILE, "w", encoding="utf-8") as f:
#             json.dump(log_data, f, ensure_ascii=False, indent=2)
#         print(f"\n  Log saved to {LOG_FILE}")

#     print("\n  DONE!")
#     return errors


# if __name__ == "__main__":
#     sys.exit(run())

#!/usr/bin/env python3
"""
Media Organizer (Symlink Edition) - Scans /mnt/data and creates symlinks
for audio/video/image files into the project's audio/, videos/, images/ directories.

Structure:
  images/{source_tag}/{original_filename}
  videos/{source_tag}/{original_filename}
  audio/{source_tag}/{original_filename}

Handles collisions by appending a short hash.
Resumable - skips already-linked files.
Zero disk space overhead - uses symlinks instead of copies.
"""

import os
import sys
import hashlib
import json
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict

# === CONFIG ===
SOURCE_DIR = Path("/mnt/data")
PROJECT_DIR = Path("/mnt/cypher/project/asset_manager")
TARGET_DIRS = {
    "image": PROJECT_DIR / "images",
    "video": PROJECT_DIR / "videos",
    "audio": PROJECT_DIR / "audio",
}
LOG_FILE = PROJECT_DIR / "organize_media_log.json"
DRY_RUN = "--dry-run" in sys.argv
NUM_WORKERS = 8  # symlink is fast, but thread pool still helps with stat calls

# === EXTENSIONS ===
VIDEO_EXTS = {
    ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm",
    ".m4v", ".ts", ".rmvb", ".rm", ".mpg", ".mpeg", ".3gp", ".vob",
}
AUDIO_EXTS = {
    ".mp3", ".flac", ".wav", ".aac", ".ogg", ".wma", ".m4a",
    ".opus", ".ape", ".mid", ".midi", ".aiff",
}
IMAGE_EXTS = {
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg",
    ".tiff", ".tif", ".ico", ".psd", ".raw", ".cr2", ".nef",
}


def classify(ext: str) -> str | None:
    ext_lower = ext.lower()
    if ext_lower in VIDEO_EXTS:
        return "video"
    if ext_lower in AUDIO_EXTS:
        return "audio"
    if ext_lower in IMAGE_EXTS:
        return "image"
    return None


def extract_source_tag(filepath: Path) -> str:
    """Extract a meaningful source tag from the path relative to /mnt/data."""
    try:
        rel = filepath.relative_to(SOURCE_DIR)
    except ValueError:
        return "untagged"

    parts = rel.parts[:-1]  # drop filename

    if not parts:
        return "root"

    # For "Pack From Shared/XXX YYY/..." use the second level
    if parts[0] == "Pack From Shared" and len(parts) >= 2:
        tag = parts[1].strip()
        if len(tag) > 80:
            tag = tag[:77] + "..."
        return sanitize_dirname(tag)

    # For baiducloud/... use first two levels
    if parts[0] == "baiducloud" and len(parts) >= 2:
        if len(parts) >= 3:
            tag = f"{parts[1][:40]}_{parts[2][:40]}"
        else:
            tag = parts[1][:80]
        return sanitize_dirname(tag)

    # For quarkpan/...
    if parts[0] == "quarkpan" and len(parts) >= 2:
        tag = parts[1][:80]
        return sanitize_dirname(tag)

    # Fallback: use first directory
    tag = parts[0][:80]
    return sanitize_dirname(tag)


def sanitize_dirname(name: str) -> str:
    """Remove problematic characters from directory name."""
    for ch in ['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\x00']:
        name = name.replace(ch, '_')
    name = name.strip(' .')
    return name or "untagged"


def file_hash_short(filepath: Path) -> str:
    """Quick hash using filename + size for collision detection."""
    stat = filepath.stat()
    raw = f"{filepath.name}:{stat.st_size}:{filepath.parent}"
    return hashlib.md5(raw.encode()).hexdigest()[:8]


def build_target_path(src_file: Path, media_type: str) -> Path:
    """Build the destination path, handling collisions."""
    target_base = TARGET_DIRS[media_type]
    source_tag = extract_source_tag(src_file)
    target_dir = target_base / source_tag
    target_file = target_dir / src_file.name

    # Handle collision: if file/link exists but different size, append hash
    if target_file.exists() or target_file.is_symlink():
        try:
            existing_size = target_file.stat().st_size
        except OSError:
            # Broken symlink or permission issue - treat as conflict
            existing_size = -1

        src_size = src_file.stat().st_size
        if existing_size == src_size:
            return target_file  # same file, skip

        # Different file, same name -> add hash
        stem = src_file.stem
        suffix = src_file.suffix
        h = file_hash_short(src_file)
        target_file = target_dir / f"{stem}_{h}{suffix}"

    return target_file


def link_file(src: Path, dst: Path) -> dict:
    """Create symlink instead of copying - near instant, zero space."""
    result = {
        "src": str(src),
        "dst": str(dst),
        "status": "ok",
        "size": 0,
        "skipped": False,
    }

    try:
        src_size = src.stat().st_size
        result["size"] = src_size

        # Skip if link already exists and points to same target with same size
        if dst.is_symlink():
            try:
                if dst.resolve() == src.resolve():
                    result["skipped"] = True
                    result["status"] = "skip_existing_link"
                    return result
            except OSError:
                # Broken symlink pointing elsewhere - remove and recreate
                dst.unlink(missing_ok=True)
        elif dst.exists():
            # Regular file exists (from old copy runs)
            existing_size = dst.stat().st_size
            if existing_size == src_size:
                result["skipped"] = True
                result["status"] = "skip_same_size_copy"
                return result
            # Different regular file - don't overwrite, let build_target_path handle hash
            # If we reach here, build_target_path should have added hash suffix already

        if DRY_RUN:
            result["status"] = "dry_run"
            return result

        # Create parent dir
        dst.parent.mkdir(parents=True, exist_ok=True)

        # ✅ Core: absolute symlink
        os.symlink(str(src.resolve()), str(dst))
        result["status"] = "linked"

    except FileExistsError:
        # Race condition: another thread created it between check and symlink
        result["status"] = "skip_race_condition"
        result["skipped"] = True
    except PermissionError as e:
        result["status"] = f"permission_error: {e}"
    except OSError as e:
        result["status"] = f"os_error: {e}"
    except Exception as e:
        result["status"] = f"error: {e}"

    return result


def scan_source() -> list[tuple[Path, str]]:
    """Walk /mnt/data and classify all media files."""
    media_files = []
    total_scanned = 0

    for root, dirs, files in os.walk(SOURCE_DIR):
        for fname in files:
            total_scanned += 1
            ext = os.path.splitext(fname)[1]
            media_type = classify(ext)
            if media_type:
                media_files.append((Path(root) / fname, media_type))

    print(f"  Scanned {total_scanned} total files, found {len(media_files)} media files")
    return media_files


def run():
    print("=" * 60)
    print("  MEDIA ORGANIZER (SYMLINK EDITION)")
    print(f"  Source: {SOURCE_DIR}")
    print(f"  Target: {PROJECT_DIR}")
    print(f"  Dry Run: {DRY_RUN}")
    print(f"  Workers: {NUM_WORKERS}")
    print("=" * 60)

    # Create target dirs
    for media_type, target_dir in TARGET_DIRS.items():
        target_dir.mkdir(parents=True, exist_ok=True)
        print(f"  [{media_type}] -> {target_dir}")

    # Scan
    print("\n[1/3] Scanning source directory...")
    t0 = time.time()
    media_files = scan_source()
    scan_time = time.time() - t0
    print(f"  Scan took {scan_time:.1f}s")

    # Stats
    counts = defaultdict(int)
    sizes = defaultdict(int)
    for fpath, mtype in media_files:
        counts[mtype] += 1
        try:
            sizes[mtype] += fpath.stat().st_size
        except OSError:
            pass

    print("\n  Summary:")
    for mtype in ["image", "video", "audio"]:
        sz_gb = sizes[mtype] / (1024 ** 3)
        print(f"    {mtype:6s}: {counts[mtype]:>6d} files, {sz_gb:.1f} GB")

    total_files = sum(counts.values())
    total_gb = sum(sizes.values()) / (1024 ** 3)
    print(f"    {'TOTAL':6s}: {total_files:>6d} files, {total_gb:.1f} GB")

    # Link
    print(f"\n[2/3] Creating symlinks ({'DRY RUN' if DRY_RUN else 'LIVE'})...")
    t1 = time.time()

    results = []
    linked = 0
    skipped = 0
    errors = 0

    with ThreadPoolExecutor(max_workers=NUM_WORKERS) as executor:
        futures = {}
        for src_file, media_type in media_files:
            target = build_target_path(src_file, media_type)
            future = executor.submit(link_file, src_file, target)
            futures[future] = (src_file, media_type)

        total = len(futures)
        done = 0
        for future in as_completed(futures):
            done += 1
            result = future.result()
            results.append(result)

            if result.get("skipped"):
                skipped += 1
            elif result["status"] in ("linked", "dry_run"):
                linked += 1
            else:
                errors += 1

            # Progress every 500 files
            if done % 500 == 0 or done == total:
                elapsed = time.time() - t1
                rate = done / elapsed if elapsed > 0 else 0
                pct = done / total * 100
                print(f"  [{done}/{total}] {pct:.0f}% | "
                      f"linked={linked} skip={skipped} err={errors} | "
                      f"{rate:.0f} files/s", flush=True)

    link_time = time.time() - t1

    # Report
    print(f"\n[3/3] Results:")
    print(f"  Total time: {link_time:.1f}s")
    print(f"  Linked: {linked}")
    print(f"  Skipped: {skipped}")
    print(f"  Errors: {errors}")

    # Log errors
    error_results = [r for r in results
                     if not r.get("skipped")
                     and r["status"] not in ("linked", "dry_run",
                                             "skip_existing_link",
                                             "skip_same_size_copy",
                                             "skip_race_condition")]
    if error_results:
        print(f"\n  Error details ({len(error_results)}):")
        for r in error_results[:20]:
            print(f"    {r['src']}: {r['status']}")
        if len(error_results) > 20:
            print(f"    ... and {len(error_results) - 20} more")

    # Save full log
    log_data = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": str(SOURCE_DIR),
        "mode": "symlink",
        "dry_run": DRY_RUN,
        "summary": {
            "total_found": total_files,
            "linked": linked,
            "skipped": skipped,
            "errors": errors,
            "scan_time_s": round(scan_time, 1),
            "link_time_s": round(link_time, 1),
        },
        "by_type": {
            mtype: {"count": counts[mtype], "size_gb": round(sizes[mtype] / (1024 ** 3), 2)}
            for mtype in ["image", "video", "audio"]
        },
        "errors": error_results,
    }

    if not DRY_RUN:
        with open(LOG_FILE, "w", encoding="utf-8") as f:
            json.dump(log_data, f, ensure_ascii=False, indent=2)
        print(f"\n  Log saved to {LOG_FILE}")

    print("\n  DONE!")
    return errors


if __name__ == "__main__":
    sys.exit(run())