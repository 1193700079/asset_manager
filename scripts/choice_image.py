"""
EdgeLord Image Culler — classify your anime gf hoard into keep/reject bins.
Three states: Keep (good for training), Reject (bad case with category), Skip (decide later).
Images are moved, never deleted. JSON logs track everything.
"""
import gradio as gr
import hashlib
import json
import os
import shutil
from datetime import datetime
from pathlib import Path
from PIL import Image

# ── Config ────────────────────────────────────────────────────────
BASE_DIR = Path("/mnt/user/joseph/data/ScrapedData/IndianRole")
REJECT_CATEGORIES = [
    "bad_anatomy",
    "bad_face", 
    "bad_style",
    "bad_composition",
    "nsfw_issue",
    "low_quality",
    "other"
]

CSS = """
#keep-btn {
    background: #00ff88 !important;
    border: 2px solid #00cc66 !important;
    color: #000 !important;
    font-weight: bold !important;
    font-size: 1.1em !important;
}
#keep-btn:hover {
    background: #00cc66 !important;
}
#reject-btn {
    background: #e94560 !important;
    border: 2px solid #ff6b6b !important;
    color: white !important;
    font-weight: bold !important;
    font-size: 1.1em !important;
}
#reject-btn:hover {
    background: #c23152 !important;
}
#skip-btn {
    background: #666 !important;
    border: 2px solid #888 !important;
    color: white !important;
    font-weight: bold !important;
}
#status-bar {
    background: #16213e;
    padding: 10px;
    border-radius: 6px;
}
.gradio-container { max-width: 100% !important; }
"""

# ── Core logic ────────────────────────────────────────────────────

def _scan_dirs() -> list[str]:
    """Discover all subdirs under BASE_DIR that look like image collections."""
    dirs = []
    if BASE_DIR.exists():
        for d in sorted(BASE_DIR.iterdir()):
            if d.is_dir() and d.name not in ["kept", "rejected"]:
                has_pngs = any(d.glob("*.png"))
                has_json = (d / "image_prompt_mapping.json").exists()
                if has_pngs or has_json:
                    dirs.append(d.name)
    return dirs


def _read_mapping(dir_path: Path) -> tuple[dict, dict | None]:
    """Parse image_prompt_mapping.json."""
    json_path = dir_path / "image_prompt_mapping.json"
    raw_data = None
    mapping_dict: dict[str, dict] = {}

    if json_path.exists():
        try:
            raw_data = json.loads(json_path.read_text(encoding="utf-8"))
            for idx, m in enumerate(raw_data.get("mappings", [])):
                for img_file in m.get("image_files", []):
                    mapping_dict[img_file] = {
                        "mapping_idx": idx,
                        "id": m.get("id"),
                        "prompt": m.get("prompt_text", ""),
                        "region": m.get("region", ""),
                        "seed": m.get("seed"),
                    }
        except (json.JSONDecodeError, KeyError):
            pass

    return mapping_dict, raw_data


def _generate_thumbnails(dir_path: Path, thumb_size: tuple = (256, 256)) -> Path:
    """Generate thumbnails for all PNGs in directory."""
    thumb_dir = dir_path / ".thumbnails"
    try:
        thumb_dir.mkdir(exist_ok=True)
    except PermissionError:
        project_dir = Path(__file__).parent
        fallback = project_dir / ".thumb_cache" / hashlib.md5(str(dir_path).encode()).hexdigest()[:12]
        fallback.mkdir(parents=True, exist_ok=True)
        thumb_dir = fallback
        print(f"  ⚠️ Read-only dir, using fallback thumbnails: {thumb_dir}")
    
    pngs = sorted(dir_path.glob("*.png"))
    total = len(pngs)
    
    for i, img_path in enumerate(pngs, 1):
        thumb_path = thumb_dir / img_path.name
        if not thumb_path.exists():
            try:
                with Image.open(img_path) as img:
                    img.thumbnail(thumb_size, Image.Resampling.LANCZOS)
                    img.save(thumb_path, "PNG", optimize=True)
            except Exception as e:
                print(f"⚠️ Failed to generate thumbnail for {img_path.name}: {e}")
        
        if i % 100 == 0:
            print(f"  📸 Generated {i}/{total} thumbnails...")
    
    print(f"✅ Thumbnails ready: {total} images")
    return thumb_dir


def _load_log(log_path: Path) -> dict:
    """Load or initialize a log JSON file."""
    if log_path.exists():
        try:
            return json.loads(log_path.read_text(encoding="utf-8"))
        except:
            pass
    return {"meta": {"total": 0}, "entries": []}


def _save_log(log_path: Path, data: dict):
    """Save log JSON file."""
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def load_directory(dir_path_str: str) -> tuple:
    """Load all pending images + metadata from a directory."""
    dir_path = Path(dir_path_str)
    if not dir_path.exists():
        return [], [], f"❌ Directory not found: {dir_path_str}", "<i>No data</i>"

    mapping_dict, raw_data = _read_mapping(dir_path)
    
    print(f"🔄 Generating thumbnails for {dir_path.name}...")
    thumb_dir = _generate_thumbnails(dir_path)

    image_meta_list: list[dict] = []
    gallery_items: list[tuple[str, str]] = []

    for img_path in sorted(dir_path.glob("*.png")):
        filename = img_path.name
        info = mapping_dict.get(filename, {})
        
        thumb_path = thumb_dir / filename
        display_path = str(thumb_path.resolve()) if thumb_path.exists() else str(img_path.resolve())

        meta = {
            "path": str(img_path.resolve()),
            "filename": filename,
            "image_id": info.get("id", "—"),
            "prompt": info.get("prompt", ""),
            "region": info.get("region", "—"),
            "has_mapping": filename in mapping_dict,
            "seed": info.get("seed", "—"),
        }
        image_meta_list.append(meta)

        tag = "📋" if meta["has_mapping"] else "📄"
        short_name = filename if len(filename) <= 35 else filename[:32] + "..."
        caption = f"{tag} #{meta['image_id']} | {short_name}"
        gallery_items.append((display_path, caption))

    # Load stats from logs
    kept_log = _load_log(BASE_DIR / "kept" / "kept_log.json")
    rejected_dir = BASE_DIR / "rejected"
    reject_counts = {}
    for cat in REJECT_CATEGORIES:
        cat_log = _load_log(rejected_dir / f"{cat}.json")
        reject_counts[cat] = cat_log["meta"]["total"]
    
    total_rejected = sum(reject_counts.values())
    total_kept = kept_log["meta"]["total"]
    total_pending = len(image_meta_list)

    stats = (
        f"📁 **{dir_path.name}** | "
        f"⏳ 待审: **{total_pending}** | "
        f"✅ 保留: **{total_kept}** | "
        f"🚫 淘汰: **{total_rejected}**"
    )
    
    # Add category breakdown if any rejects
    if total_rejected > 0:
        cat_parts = [f"{cat.replace('bad_', '').replace('_', ' ')}:{count}" 
                     for cat, count in reject_counts.items() if count > 0]
        stats += f" ({', '.join(cat_parts)})"

    preview = "<i>Click an image in the gallery to see details here</i>"
    return gallery_items, image_meta_list, stats, preview


def select_image(image_meta_list: list, evt: gr.SelectData) -> tuple:
    """When user clicks a gallery thumbnail, show details AND track the index."""
    idx = evt.index
    if not image_meta_list or idx is None or idx >= len(image_meta_list):
        return "<i>Invalid selection</i>", None

    m = image_meta_list[idx]
    prompt_snippet = m["prompt"][:300] + "…" if len(m["prompt"]) > 300 else m["prompt"]

    html = f"""
    <div style="padding:12px; background:#1a1a2e; border:1px solid #e94560; border-radius:8px; font-family:monospace;">
        <h3 style="color:#e94560; margin-top:0;">📋 Image Details</h3>
        <table style="color:#ccc; width:100%;">
            <tr><td style="color:#888;">Filename</td><td style="color:#fff;"><b>{m['filename']}</b></td></tr>
            <tr><td style="color:#888;">Image ID</td><td>{m['image_id']}</td></tr>
            <tr><td style="color:#888;">Region</td><td>{m['region']}</td></tr>
            <tr><td style="color:#888;">Seed</td><td>{m['seed']}</td></tr>
            <tr><td style="color:#888;">JSON Mapping</td><td style="color:{'#00ff88' if m['has_mapping'] else '#ff6b6b'};">{'✅ YES' if m['has_mapping'] else '❌ NONE'}</td></tr>
            <tr><td style="color:#888;">Prompt</td><td style="font-size:0.85em;color:#aaa;">{prompt_snippet}</td></tr>
        </table>
    </div>
    """
    return html, idx


def keep_image(dir_path_str: str, image_meta_list: list, selected_index: int | None) -> tuple:
    """Move image to kept/, log it, advance to next."""
    if selected_index is None or not image_meta_list or selected_index >= len(image_meta_list):
        return *load_directory(dir_path_str), "<span style='color:#ff6b6b;'>⚠️ Select an image first</span>"

    img = image_meta_list[selected_index]
    img_path = Path(img["path"])
    filename = img["filename"]
    
    # Move image to kept/
    kept_dir = BASE_DIR / "kept"
    kept_dir.mkdir(exist_ok=True)
    dest_path = kept_dir / filename
    
    if img_path.exists():
        shutil.move(str(img_path), str(dest_path))
    
    # Move thumbnail too
    dir_path = Path(dir_path_str)
    for thumb_candidate in [
        dir_path / ".thumbnails" / filename,
        Path(__file__).parent / ".thumb_cache" / hashlib.md5(str(dir_path).encode()).hexdigest()[:12] / filename,
    ]:
        if thumb_candidate.exists():
            thumb_dest = kept_dir / ".thumbnails" / filename
            thumb_dest.parent.mkdir(exist_ok=True)
            shutil.move(str(thumb_candidate), str(thumb_dest))
            break
    
    # Log to kept_log.json
    kept_log_path = kept_dir / "kept_log.json"
    kept_log = _load_log(kept_log_path)
    
    entry = {
        "decided_at": datetime.now().isoformat(),
        "filename": filename,
        "image_id": img["image_id"],
        "prompt": img["prompt"],
        "seed": img["seed"],
        "region": img["region"],
        "source_dir": dir_path.name,
    }
    kept_log["entries"].append(entry)
    kept_log["meta"]["total"] = len(kept_log["entries"])
    kept_log["meta"]["source"] = dir_path.name
    _save_log(kept_log_path, kept_log)
    
    # Remove from source JSON if mapped
    if img["has_mapping"]:
        json_path = dir_path / "image_prompt_mapping.json"
        if json_path.exists():
            data = json.loads(json_path.read_text(encoding="utf-8"))
            data["mappings"] = [
                m for m in data.get("mappings", [])
                if filename not in m.get("image_files", [])
            ]
            data["meta"]["total"] = len(data["mappings"])
            json_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    
    msg = f"<span style='color:#00ff88;'>✅ Kept: <b>{filename}</b></span>"
    return *load_directory(dir_path_str), msg


def reject_image(dir_path_str: str, image_meta_list: list, selected_index: int | None, category: str) -> tuple:
    """Move image to rejected/images/, log to category JSON, advance to next."""
    if selected_index is None or not image_meta_list or selected_index >= len(image_meta_list):
        return *load_directory(dir_path_str), "<span style='color:#ff6b6b;'>⚠️ Select an image first</span>"
    
    if not category or category not in REJECT_CATEGORIES:
        return *load_directory(dir_path_str), "<span style='color:#ff6b6b;'>⚠️ Select a reject category</span>"

    img = image_meta_list[selected_index]
    img_path = Path(img["path"])
    filename = img["filename"]
    
    # Move image to rejected/images/
    rejected_dir = BASE_DIR / "rejected"
    rejected_images_dir = rejected_dir / "images"
    rejected_images_dir.mkdir(parents=True, exist_ok=True)
    dest_path = rejected_images_dir / filename
    
    if img_path.exists():
        shutil.move(str(img_path), str(dest_path))
    
    # Move thumbnail too
    dir_path = Path(dir_path_str)
    for thumb_candidate in [
        dir_path / ".thumbnails" / filename,
        Path(__file__).parent / ".thumb_cache" / hashlib.md5(str(dir_path).encode()).hexdigest()[:12] / filename,
    ]:
        if thumb_candidate.exists():
            thumb_dest = rejected_images_dir / ".thumbnails" / filename
            thumb_dest.parent.mkdir(exist_ok=True)
            shutil.move(str(thumb_candidate), str(thumb_dest))
            break
    
    # Log to {category}.json
    cat_log_path = rejected_dir / f"{category}.json"
    cat_log = _load_log(cat_log_path)
    
    entry = {
        "decided_at": datetime.now().isoformat(),
        "filename": filename,
        "image_id": img["image_id"],
        "prompt": img["prompt"],
        "seed": img["seed"],
        "region": img["region"],
        "source_dir": dir_path.name,
        "category": category,
    }
    cat_log["entries"].append(entry)
    cat_log["meta"]["total"] = len(cat_log["entries"])
    cat_log["meta"]["category"] = category
    cat_log["meta"]["source"] = dir_path.name
    _save_log(cat_log_path, cat_log)
    
    # Remove from source JSON if mapped
    if img["has_mapping"]:
        json_path = dir_path / "image_prompt_mapping.json"
        if json_path.exists():
            data = json.loads(json_path.read_text(encoding="utf-8"))
            data["mappings"] = [
                m for m in data.get("mappings", [])
                if filename not in m.get("image_files", [])
            ]
            data["meta"]["total"] = len(data["mappings"])
            json_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    
    msg = f"<span style='color:#e94560;'>🚫 Rejected ({category}): <b>{filename}</b></span>"
    return *load_directory(dir_path_str), msg


def skip_image(dir_path_str: str, image_meta_list: list, selected_index: int | None) -> tuple:
    """Skip to next image without action."""
    msg = "<span style='color:#888;'>⏭️ Skipped</span>"
    return *load_directory(dir_path_str), msg


# ── Gradio UI ─────────────────────────────────────────────────────

def build_ui():
    available_dirs = _scan_dirs()
    default_dir_name = "generated_output_anime_mapped" if "generated_output_anime_mapped" in available_dirs else (available_dirs[0] if available_dirs else "")
    default_dir_path = str(BASE_DIR / default_dir_name) if default_dir_name else ""

    with gr.Blocks(title="EdgeLord Image Culler") as app:
        gr.Markdown(
            """
            # 🔥 EdgeLord Image Culler
            **Classify images: Keep (good) | Reject (bad with category) | Skip (decide later)**
            """
        )

        with gr.Row():
            dir_dropdown = gr.Dropdown(
                label="📁 Source Directory",
                choices=available_dirs,
                value=default_dir_name,
                scale=3,
                interactive=True,
            )
            custom_path = gr.Textbox(
                label="🔧 Or paste a custom path",
                placeholder="/absolute/path/to/image/dir",
                scale=2,
            )
            load_btn = gr.Button("🔄 Load", variant="secondary", scale=1)

        status_md = gr.Markdown("📂 Select a directory and hit Load", elem_id="status-bar")

        with gr.Row(equal_height=False):
            with gr.Column(scale=3):
                gallery = gr.Gallery(
                    label="🖼️ Pending Images — click one to select",
                    columns=6,
                    rows=4,
                    height="65vh",
                    object_fit="contain",
                    allow_preview=True,
                    selected_index=None,
                )

            with gr.Column(scale=1, min_width=320):
                preview_html = gr.HTML(value="<i>Click an image to preview</i>")
                
                with gr.Row():
                    reject_category = gr.Dropdown(
                        label="Reject Category",
                        choices=REJECT_CATEGORIES,
                        value=REJECT_CATEGORIES[0],
                        interactive=True,
                    )
                
                with gr.Row():
                    keep_btn = gr.Button(
                        "✅ Keep",
                        variant="primary",
                        elem_id="keep-btn",
                        size="lg",
                    )
                    reject_btn = gr.Button(
                        "🚫 Reject",
                        variant="stop",
                        elem_id="reject-btn",
                        size="lg",
                    )
                    skip_btn = gr.Button(
                        "⏭️ Skip",
                        variant="secondary",
                        elem_id="skip-btn",
                    )
                
                action_msg = gr.HTML(value="")

        meta_state = gr.State([])
        selected_idx_state = gr.State(None)
        current_dir_state = gr.State(default_dir_path if default_dir_path else "")

        def _load_and_track(dir_path_str: str) -> tuple:
            gallery_items, meta, stats, preview = load_directory(dir_path_str)
            return gallery_items, meta, stats, preview, dir_path_str

        def _load_dropdown(d: str) -> tuple:
            path = str(BASE_DIR / d)
            gallery_items, meta, stats, preview = load_directory(path)
            return gallery_items, meta, stats, preview, path, path

        dir_dropdown.change(
            fn=_load_dropdown,
            inputs=[dir_dropdown],
            outputs=[gallery, meta_state, status_md, preview_html, custom_path, current_dir_state],
        )

        load_btn.click(
            fn=_load_and_track,
            inputs=[custom_path],
            outputs=[gallery, meta_state, status_md, preview_html, current_dir_state],
        )
        custom_path.submit(
            fn=_load_and_track,
            inputs=[custom_path],
            outputs=[gallery, meta_state, status_md, preview_html, current_dir_state],
        )

        gallery.select(
            fn=select_image,
            inputs=[meta_state],
            outputs=[preview_html, selected_idx_state],
        )

        keep_btn.click(
            fn=keep_image,
            inputs=[current_dir_state, meta_state, selected_idx_state],
            outputs=[gallery, meta_state, status_md, preview_html, action_msg],
        )

        reject_btn.click(
            fn=reject_image,
            inputs=[current_dir_state, meta_state, selected_idx_state, reject_category],
            outputs=[gallery, meta_state, status_md, preview_html, action_msg],
        )

        skip_btn.click(
            fn=skip_image,
            inputs=[current_dir_state, meta_state, selected_idx_state],
            outputs=[gallery, meta_state, status_md, preview_html, action_msg],
        )

        if default_dir_path:
            def _initial_load():
                gallery, meta, stats, preview = load_directory(default_dir_path)
                return gallery, meta, stats, preview, default_dir_path
            
            app.load(
                fn=_initial_load,
                inputs=[],
                outputs=[gallery, meta_state, status_md, preview_html, current_dir_state],
            )

    return app


if __name__ == "__main__":
    default = str(BASE_DIR / "generated_output_anime_mapped")
    print(f"🔥 EdgeLord Image Culler starting...")
    print(f"📁 Default directory: {default}")
    print(f"📂 Available collections: {_scan_dirs()}")

    ui = build_ui()
    ui.queue(default_concurrency_limit=3)
    ui.launch(
        server_name="0.0.0.0",
        server_port=7862,
        share=False,
        show_error=True,
        css=CSS,
        theme=gr.themes.Soft(primary_hue="green", secondary_hue="slate"),
    )
