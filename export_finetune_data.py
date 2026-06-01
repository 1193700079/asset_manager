#!/usr/bin/env python3
"""
导出人工纠正的预筛选数据为 Qwen VL 微调 JSONL 格式。

数据来源：PostgreSQL saved_frames 表中被人工纠正(overridden)的记录。
输出格式：Qwen VL 多模态微调 JSONL

用法：
    python export_finetune_data.py                    # 导出全部
    python export_finetune_data.py --type image       # 仅图片
    python export_finetune_data.py --type video       # 仅视频
    python export_finetune_data.py --dry-run          # 仅统计不写入
    python export_finetune_data.py -o /path/out.jsonl # 指定输出路径
    python export_finetune_data.py --concurrency 10   # 设置并发（预留）
"""

import argparse
import json
import os
import shutil
import sys
from collections import Counter
from pathlib import Path

try:
    import psycopg2
except ImportError:
    print("错误: 缺少 psycopg2 模块，请运行: pip install psycopg2-binary")
    sys.exit(1)

# ─── 默认配置 ────────────────────────────────────────────────────────────────────
DEFAULT_IMAGES_ROOT = Path(__file__).parent / "images"
DEFAULT_OUTPUT = Path(__file__).parent / "train" / "Trainingdata_vl" / "data.jsonl"


# ─── 预筛选 Prompt（与 kimi.mjs 中 preScreenImage 保持一致）─────────────────────
PRESCREEN_PROMPT = """你是一个图片预筛选专家。判断这张图片是否包含可用的 NSFW（成人）内容。

请依次检查以下条件：

1. **NSFW内容**：是否包含成人内容？
   - 通过：裸露、性行为、性暗示、色情场景
   - 排除：纯风景、美食、建筑、动物、普通人物非色情照片（SFW）

2. **图片质量**：NSFW图片是否清晰、高质量？
   - 排除：模糊不清、分辨率极低、严重压缩失真、画面损坏/花屏
   - 排除：有马赛克/打码覆盖关键部位（面部、身体、私密区域）
   - 注意：轻微压缩瑕疵不算低质量

3. **真实性**：是否为真实摄影或高质量截图？
   - 排除：卡通/动漫/插画、明显的低质量AI生成（如畸形手指、面部扭曲）、低质量3D渲染
   - 注意：高质量AI生成（接近真实照片）可以通过

4. **水印检测**：图片是否带有文字水印？
   - 重点关注：左下角、右下角的文字水印（网站名、用户名、品牌标识等）
   - 也注意：图片中央、顶部等位置的半透明文字水印
   - 重要：水印检测仅在条件1-3全部通过后才生效！非NSFW或低质量图片有水印 → 直接拒绝
   - 高质量NSFW图片有明显水印 → 通过，归类为 watermark（值得去水印后使用）
   - 无水印或水印极小不影响画面 → 正常归类

判断流程：
1. 先检查条件1-3（NSFW + 质量 + 真实性），任何一个不通过 → should_annotate: false
2. 条件1-3全部通过后，再检查水印：有明显水印 → 归为 watermark；无水印 → 按人脸分类

如果通过（should_annotate: true），还需分类：
- **watermark**：条件1-3全部通过 + 有明显文字水印（尤其左下角、右下角）→ 高质量NSFW但需去水印后使用
- **face_nsfw**：无水印，图片中有完整、清晰、高清的人脸可见（正脸或3/4侧脸，五官清楚）且包含 NSFW 内容 → 适合换脸素材
- **body_nsfw**：无水印，NSFW 内容但无清晰完整人脸（仅身体局部、背面、脸被遮挡/截断/模糊等）→ NSFW训练素材

注意：watermark 仅用于「高质量NSFW + 有明显水印」的情况！有水印但不是高质量NSFW → 直接拒绝（should_annotate: false）。

输出严格JSON（不要输出任何其他内容）：
{"should_annotate": true或false, "reason": "简短判断理由（20字以内）", "confidence": "high或medium或low", "category": "face_nsfw或body_nsfw或watermark或none"}

category 说明：
- watermark: 高质量NSFW + 有明显文字水印，值得去水印后使用（仅限高质量NSFW图片！）
- face_nsfw: 无水印 + 有清晰完整人脸 + NSFW内容（最佳换脸素材）
- body_nsfw: 无水印 + NSFW内容但无清晰人脸（NSFW训练素材）
- none: should_annotate为false时使用

confidence 说明：
- high: 非常确定
- medium: 基本确定但有少许疑虑
- low: 不太确定（建议人工复核）""".strip()


def get_database_url():
    """获取数据库连接字符串：优先环境变量，其次 .env 文件"""
    url = os.environ.get("DATABASE_URL")
    if url:
        return url

    # 尝试从 .env 文件解析
    env_paths = [
        Path(__file__).parent / "video-frame-extractor" / ".env",
        Path(__file__).parent / "video-frame-extractor" / "server" / ".env",
    ]
    for env_path in env_paths:
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                line = line.strip()
                if line.startswith("DATABASE_URL="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")

    print("错误: 未找到 DATABASE_URL。请设置环境变量或确保 .env 文件存在。")
    sys.exit(1)


def query_overridden_records(conn, record_type="all"):
    """查询人工纠正的预筛选记录"""
    records = []

    with conn.cursor() as cur:
        # 图片预筛选：description 中 reason='Manual override'
        if record_type in ("all", "image"):
            cur.execute("""
                SELECT video_path, description
                FROM saved_frames
                WHERE format = 'image_prescreen'
                  AND description LIKE '%Manual override%'
            """)
            for row in cur.fetchall():
                path, desc_str = row
                try:
                    desc = json.loads(desc_str) if desc_str else {}
                except json.JSONDecodeError:
                    continue
                records.append({"path": path, "desc": desc, "type": "image"})

        # 视频预筛选：description 中 overridden=true
        if record_type in ("all", "video"):
            cur.execute("""
                SELECT video_path, description
                FROM saved_frames
                WHERE format = 'video_prescreen'
                  AND (description LIKE '%"overridden":true%'
                       OR description LIKE '%"overridden": true%')
            """)
            for row in cur.fetchall():
                path, desc_str = row
                try:
                    desc = json.loads(desc_str) if desc_str else {}
                except json.JSONDecodeError:
                    continue
                records.append({"path": path, "desc": desc, "type": "video"})

    return records


def build_jsonl_entry(record: dict) -> dict:
    """构建单条 Qwen VL 微调 JSONL 条目"""
    desc = record["desc"]
    path = record.get("abs_path", record["path"])
    should_annotate = desc.get("should_annotate", False)
    category = desc.get("category", "none" if not should_annotate else "body_nsfw")

    assistant_output = json.dumps({
        "should_annotate": should_annotate,
        "reason": "人工审核确认",
        "confidence": "high",
        "category": category,
    }, ensure_ascii=False)

    return {
        "messages": [
            {
                "role": "user",
                "content": [
                    {"text": PRESCREEN_PROMPT},
                    {"image": path},
                ]
            },
            {
                "role": "assistant",
                "content": [
                    {"text": assistant_output}
                ]
            }
        ]
    }


def print_statistics(records):
    """打印统计信息"""
    total = len(records)
    type_counter = Counter(r["type"] for r in records)
    category_counter = Counter(r["desc"].get("category", "unknown") for r in records)
    annotate_counter = Counter(
        "pass" if r["desc"].get("should_annotate") else "reject"
        for r in records
    )

    print(f"\n{'='*50}")
    print(f"  导出统计")
    print(f"{'='*50}")
    print(f"  总记录数: {total}")
    print(f"\n  按来源分布:")
    for t, c in sorted(type_counter.items()):
        print(f"    {t}: {c}")
    print(f"\n  按分类(category)分布:")
    for cat, c in sorted(category_counter.items()):
        print(f"    {cat}: {c}")
    print(f"\n  按判定结果分布:")
    for decision, c in sorted(annotate_counter.items()):
        label = "通过(should_annotate=true)" if decision == "pass" else "拒绝(should_annotate=false)"
        print(f"    {label}: {c}")
    print(f"{'='*50}\n")


def main():
    parser = argparse.ArgumentParser(description="导出人工纠正数据为 Qwen VL 微调 JSONL 格式")
    parser.add_argument("--images-root", default=None,
                        help=f"图片根目录 (默认: {DEFAULT_IMAGES_ROOT})")
    parser.add_argument("-o", "--output", default=None,
                        help="输出文件路径 (默认: train/Trainingdata_vl/data.jsonl)")
    parser.add_argument("--type", choices=["image", "video", "all"], default="all",
                        help="导出类型: image/video/all (默认: all)")
    parser.add_argument("--dry-run", action="store_true",
                        help="仅统计不实际写入")
    parser.add_argument("--skip-missing", action="store_true", default=True,
                        help="跳过不存在的文件 (默认开启)")
    args = parser.parse_args()

    # 确定输出路径
    if args.output:
        output_path = Path(args.output)
    else:
        output_path = DEFAULT_OUTPUT

    # 连接数据库
    db_url = get_database_url()
    print(f"连接数据库...")
    try:
        conn = psycopg2.connect(db_url)
    except Exception as e:
        print(f"错误: 无法连接数据库: {e}")
        sys.exit(1)

    # 查询数据
    print(f"查询人工纠正记录 (type={args.type})...")
    records = query_overridden_records(conn, args.type)
    conn.close()

    if not records:
        print("未找到人工纠正记录。")
        return

    # 验证文件存在性（基于 images_root 拼接绝对路径）
    images_root = Path(args.images_root) if args.images_root else DEFAULT_IMAGES_ROOT
    print(f"图片根目录: {images_root}")

    valid_records = []
    missing_count = 0
    for r in records:
        abs_path = images_root / r["path"]
        if abs_path.exists():
            r["abs_path"] = str(abs_path)
            valid_records.append(r)
        else:
            missing_count += 1
            if missing_count <= 5:
                print(f"  警告: 文件不存在，跳过: {r['path']}")

    if missing_count > 5:
        print(f"  ... 共 {missing_count} 个文件不存在，已跳过")
    elif missing_count > 0:
        print(f"  共 {missing_count} 个文件不存在，已跳过")

    # 打印统计
    print_statistics(valid_records)

    if args.dry_run:
        print("[DRY RUN] 不写入文件。")
        return

    if not valid_records:
        print("没有有效记录可导出。")
        return

    # 备份已有文件
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists():
        backup_path = output_path.with_suffix(".jsonl.bak")
        shutil.copy2(output_path, backup_path)
        print(f"已备份: {backup_path}")

    # 写入 JSONL
    with open(output_path, "w", encoding="utf-8") as f:
        for r in valid_records:
            entry = build_jsonl_entry(r)
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    print(f"成功导出 {len(valid_records)} 条记录到: {output_path}")


if __name__ == "__main__":
    main()
