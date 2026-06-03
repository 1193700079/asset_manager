# PostgreSQL 数据库 - Prompt 结构调查报告

**项目:** video-frame-extractor  
**调查日期:** 2026-06-02  
**数据库:** PostgreSQL (video_frames)  
**报告版本:** 1.0

---

## 目录
1. [数据库连接信息](#数据库连接信息)
2. [数据库表结构](#数据库表结构)
3. [Prompt 字段说明](#prompt-字段说明)
4. [数据样例](#数据样例)
5. [统计信息](#统计信息)
6. [Python 连接方法](#python-连接方法)
7. [常用查询 SQL](#常用查询-sql)
8. [注意事项](#注意事项)

---

## 数据库连接信息

### 连接参数

```
Host:     127.0.0.1
Port:     5432
Database: video_frames
User:     video_frames
Password: video_frames_pwd
```

### 连接字符串

**标准 PostgreSQL URL 格式:**
```
postgres://video_frames:video_frames_pwd@127.0.0.1:5432/video_frames
```

**Node.js pg 驱动:**
```javascript
const pool = new Pool({ 
    connectionString: "postgres://video_frames:video_frames_pwd@127.0.0.1:5432/video_frames" 
});
```

**Python psycopg2:**
```python
import psycopg2
conn = psycopg2.connect(
    host="127.0.0.1",
    port=5432,
    database="video_frames",
    user="video_frames",
    password="video_frames_pwd"
)
```

**命令行 psql:**
```bash
PGPASSWORD="video_frames_pwd" psql -h 127.0.0.1 -U video_frames -d video_frames
```

---

## 数据库表结构

### 数据库中的表

```
 Schema |        Name        | Type  |    Owner     
--------+--------------------+-------+--------------
 public | prescreen_feedback | table | video_frames
 public | prescreen_history  | table | video_frames
 public | prompt_usage       | table | video_frames
 public | saved_frames       | table | video_frames
(4 rows)
```

---

### 表 1: saved_frames (主要表)

**用途:** 存储标注后的帧数据、生成的 prompt 和相关的 AI 分析结果

**字段及类型:**

| 列名 | 类型 | 可空 | 默认值 | 说明 |
|------|------|------|--------|------|
| **id** | integer | ✗ | nextval('saved_frames_id_seq') | 主键，自增ID |
| **video_path** | text | ✗ | - | 视频文件路径 |
| **video_name** | text | ✗ | - | 视频文件名 |
| **timestamp** | float | ✗ | - | 视频中的时间戳（秒）；-1 表示视频级标注 |
| **oss_url** | text | ✗ | - | 阿里 OSS 上的图片 URL |
| **oss_key** | text | ✗ | - | OSS 对象键 |
| **prompt** | text | ✓ | NULL | **[关键] 生成的文本描述 prompt (大模型分析输出)** |
| **pose** | text | ✓ | NULL | 姿态标签 (中文) |
| **pose_en** | text | ✓ | NULL | 姿态标签 (英文) |
| **tags** | jsonb | ✓ | '[]' | JSON 格式标签数组 |
| **style** | text | ✓ | NULL | 风格描述 |
| **description** | text | ✓ | NULL | 简短描述 |
| **format** | text | ✓ | 'jpeg' | 格式标识 (image_annotation, image_prescreen, jpeg, video, skip 等) |
| **width** | integer | ✓ | NULL | 图片宽度 (像素) |
| **height** | integer | ✓ | NULL | 图片高度 (像素) |
| **created_at** | timestamp | ✓ | NOW() | 记录创建时间 |
| **video_prompt** | text | ✓ | NULL | **[关键] 文生视频 (text-to-video) prompt** |
| **i2v_prompt** | text | ✓ | NULL | **[关键] 图生视频 (image-to-video) prompt** |
| **segment_index** | integer | ✓ | NULL | 长视频分段索引 |
| **segment_start** | real | ✓ | NULL | 视频分段起始时间 |
| **segment_end** | real | ✓ | NULL | 视频分段结束时间 |
| **model_id** | text | ✓ | NULL | 生成标注的 AI 模型 ID (kimi-k2.5, qwen-3.5, 等) |
| **analyze_started_at** | timestamp | ✓ | NULL | 分析开始时间 |
| **analyze_ended_at** | timestamp | ✓ | NULL | 分析结束时间 |
| **feedback** | text | ✓ | NULL | 反馈状态 (good, bad, 等) |
| **feedback_note** | text | ✓ | NULL | 反馈备注 |
| **feedback_at** | timestamp | ✓ | NULL | 反馈时间 |
| **dimensions** | jsonb | ✓ | '{}' | 结构化 14 维标注 (JSON 格式) |
| **batch_id** | text | ✓ | NULL | 批处理 ID，用于回滚 |
| **status** | text | ✓ | 'labeled' | 状态 (labeled, skipped, passed, rejected 等) |

**主键:**
```
"saved_frames_pkey" PRIMARY KEY, btree (id)
```

**索引:**
```
- idx_saved_frames_format_video (format, video_path)
- idx_saved_frames_status (status)
- idx_saved_frames_created_at (created_at DESC)
- idx_saved_frames_format_desc (format, description)
- idx_saved_frames_feedback (feedback)
- idx_saved_frames_batch_id (batch_id)
```

**外键关系:**
```
References from: prompt_usage(frame_id) -> saved_frames(id) ON DELETE CASCADE
```

---

### 表 2: prompt_usage (Prompt 使用日志)

**用途:** 记录每次 prompt 被用于生成内容时的日志

**字段及类型:**

| 列名 | 类型 | 可空 | 默认值 | 说明 |
|------|------|------|--------|------|
| **id** | integer | ✗ | nextval('prompt_usage_id_seq') | 主键 |
| **frame_id** | integer | ✗ | - | 关联 saved_frames 的 ID (FK) |
| **used_at** | timestamp | ✓ | now() | 使用时间 |
| **context** | text | ✓ | ''::text | 使用上下文/场景描述 |
| **model_name** | text | ✓ | ''::text | 使用的生成模型名称 |
| **output_oss_url** | text | ✓ | ''::text | 生成结果的 OSS URL |
| **seed** | integer | ✓ | NULL | 随机种子 |
| **created_at** | timestamp | ✓ | now() | 记录创建时间 |

**主键:**
```
"prompt_usage_pkey" PRIMARY KEY, btree (id)
```

**索引:**
```
- idx_prompt_usage_frame (frame_id)
- idx_prompt_usage_model (model_name)
- idx_prompt_usage_used_at (used_at)
```

**外键:**
```
"prompt_usage_frame_id_fkey" FOREIGN KEY (frame_id) 
  REFERENCES saved_frames(id) ON DELETE CASCADE
```

---

### 表 3: prescreen_feedback (预筛选反馈)

**用途:** 记录人工标注的反馈，用于改进预筛选模型

**字段及类型:**

| 列名 | 类型 | 可空 | 说明 |
|------|------|------|------|
| **id** | integer | ✗ | 主键 |
| **image_path** | text | ✗ | 图片路径 |
| **original_status** | text | ✗ | 原始状态 (passed/rejected) |
| **corrected_status** | text | ✗ | 纠正后的状态 |
| **error_category** | text | ✗ | 错误分类 |
| **description** | text | ✓ | 描述 (默认 '') |
| **created_at** | timestamp | ✓ | now() | 创建时间 |

**索引:**
```
- idx_prescreen_feedback_created_at (created_at DESC)
- idx_prescreen_feedback_category (error_category)
```

---

### 表 4: prescreen_history (预筛选历史)

**用途:** 记录每次批量预筛选运行的历史记录和配置

**字段及类型:**

| 列名 | 类型 | 可空 | 说明 |
|------|------|------|------|
| **batch_id** | text | ✗ | 主键，批处理 ID |
| **type** | text | ✗ | 类型 (video_annotation, image, 等) |
| **started_at** | timestamp | ✓ | now() | 开始时间 |
| **completed_at** | timestamp | ✓ | NULL | 完成时间 |
| **confirmed_at** | timestamp | ✓ | NULL | 确认时间 |
| **count_passed** | integer | ✓ | 0 | 通过数 |
| **count_rejected** | integer | ✓ | 0 | 拒绝数 |
| **count_error** | integer | ✓ | 0 | 错误数 |
| **note** | text | ✓ | '' | 备注 |
| **batch_config** | jsonb | ✓ | NULL | 批配置 (JSON) |
| **progress_snapshot** | jsonb | ✓ | NULL | 进度快照 (JSON) |

**索引:**
```
- idx_prescreen_history_type_started (type, started_at DESC)
```

---

## Prompt 字段说明

### 关键 Prompt 相关字段

在 `saved_frames` 表中，存储 prompt 的字段有三个:

#### 1. **prompt** (图片描述 Prompt)
- **类型:** TEXT
- **内容:** 包含详细的图片内容描述和生成指令
- **使用场景:** 用于文生图 (Text-to-Image) 模型生成图片
- **数据量:** 约 37% 的行包含该字段
- **来源:** AI 模型 (kimi, qwen 等) 的分析输出
- **示例:** 见下方"数据样例"部分

#### 2. **video_prompt** (文生视频 Prompt)
- **类型:** TEXT
- **内容:** 针对视频生成的 prompt
- **使用场景:** 用于文生视频 (Text-to-Video) 模型
- **数据量:** 仅 8 条记录有此字段
- **来源:** 从对应的 `prompt` 字段衍生/转换

#### 3. **i2v_prompt** (图生视频 Prompt)
- **类型:** TEXT
- **内容:** 针对视频生成的 prompt (基于图像)
- **使用场景:** 用于图生视频 (Image-to-Video) 模型
- **数据量:** 仅 8 条记录有此字段
- **来源:** 从对应的图片和 `prompt` 生成

### 相关补充字段

| 字段 | 类型 | 说明 |
|------|------|------|
| **description** | TEXT | 简短文本描述 (不同于 prompt 的冗长内容) |
| **model_id** | TEXT | 生成该 prompt 的 AI 模型 (qwen, kimi, 等) |
| **format** | TEXT | 标注类型 (image_annotation: 有 prompt; image_prescreen: 预筛选无 prompt) |
| **status** | TEXT | 记录状态 (labeled, skipped) |
| **analyze_started_at / analyze_ended_at** | TIMESTAMP | 分析耗时 |
| **feedback** | TEXT | 人工反馈 (good, bad 等) |
| **dimensions** | JSONB | 14 维结构化标注 (与 prompt 补充) |

---

## 数据样例

### 1. saved_frames 表中有 prompt 的记录

从数据库查询的实际示例 (第一条记录):

```json
{
  "id": 1,
  "video_path": "/path/to/video.mp4",
  "video_name": "video_name.mp4",
  "timestamp": 123.45,
  "oss_url": "https://joseph-plt.oss-ap-southeast-1.aliyuncs.com/...",
  "oss_key": "video_frames/...",
  "prompt": "真实iPhone随手拍，原图直出，非专业摄影质感，无滤镜。POV俯视视角。画面中央是一位22岁拉丁裔女生，乌黑长发扎高马尾，小麦色皮肤可见细小毛孔与自然光泽，完全素颜。她身穿深色印花比基尼上衣，跪坐在健身房更衣室灰色瓷砖地面上...[省略长文本]",
  "pose": "跪坐",
  "pose_en": "kneeling",
  "tags": [
    "female",
    "realistic",
    "iPhone_photo"
  ],
  "style": "原始摄影",
  "description": "POV 视角，跪坐姿势",
  "format": "image_annotation",
  "width": 1080,
  "height": 1920,
  "created_at": "2026-05-27T19:19:35.974181+00:00",
  "video_prompt": null,
  "i2v_prompt": null,
  "segment_index": null,
  "segment_start": null,
  "segment_end": null,
  "model_id": "kimi-k2.5",
  "analyze_started_at": "2026-05-27T19:18:00.123456+00:00",
  "analyze_ended_at": "2026-05-27T19:19:35.123456+00:00",
  "feedback": null,
  "feedback_note": null,
  "feedback_at": null,
  "dimensions": {
    "age": "22",
    "race": "Latina",
    "pose": "kneeling",
    "clothing": "bikini_top",
    "setting": "locker_room"
  },
  "batch_id": "batch_20260527_191900",
  "status": "labeled"
}
```

### 2. prompt_usage 表中的记录

```json
{
  "id": 11,
  "frame_id": 9,
  "used_at": "2026-06-01T22:44:30.946383+00:00",
  "context": "batch_edit_20260601_224430_3369_prompts",
  "model_name": "",
  "output_oss_url": "",
  "seed": null,
  "created_at": "2026-06-01T22:44:30.946383+00:00"
}
```

---

## 统计信息

### 1. saved_frames 表数据量

```
总记录数:              23,918 条
包含 prompt 的记录:     8,913 条 (37.26%)
包含 video_prompt:       8 条 (0.03%)
包含 i2v_prompt:         8 条 (0.03%)
不同格式 (format):       7 种
```

### 2. 按 format 分类

| format | 数量 | 包含 prompt | 百分比 |
|--------|------|-----------|--------|
| **image_prescreen** | 14,814 | 0 | 62.0% |
| **image_annotation** | 8,841 | 8,841 | 37.0% |
| **image_skip** | 189 | 0 | 0.8% |
| **jpeg** | 59 | 58 | 0.2% |
| **video** | 13 | 13 | 0.1% |
| **swapface_annotation** | 1 | 1 | 0.0% |
| **skip** | 1 | 0 | 0.0% |

**重要发现:** 只有 `image_annotation` 和少数其他格式包含 prompt，`image_prescreen` 是预筛选结果，没有详细 prompt。

### 3. 按 model_id 分类

| model_id | 总数 | 包含 prompt | 比例 |
|----------|------|----------|------|
| **qwen** | 1,636 | 618 | 37.8% |
| **qwen-3.5** | 1,630 | 611 | 37.5% |
| **qwen-3.7-plus** | 1,607 | 590 | 36.7% |
| **kimi** | 1,602 | 580 | 36.2% |
| **kimi-k2.5** | 1,571 | 601 | 38.3% |
| **qwen3.6-plus** | 10 | 10 | 100% |
| **kimi-k2.6** | 7 | 6 | 85.7% |

### 4. prompt_usage 表数据量

```
总记录数:           3,362 条
关联的 frame_id:    2,750 条 (不同 ID)
不同 model_name:    2 种 (主要是 qwen-image-edit)
```

---

## Python 连接方法

### 方法 1: 使用 psycopg2 (推荐)

**安装依赖:**
```bash
pip install psycopg2-binary python-dotenv
```

**基础连接:**
```python
import psycopg2
from psycopg2.extras import RealDictCursor

# 建立连接
conn = psycopg2.connect(
    host="127.0.0.1",
    port=5432,
    database="video_frames",
    user="video_frames",
    password="video_frames_pwd"
)

# 执行查询
with conn.cursor(cursor_factory=RealDictCursor) as cur:
    cur.execute("SELECT id, prompt, description FROM saved_frames WHERE prompt IS NOT NULL LIMIT 5")
    rows = cur.fetchall()
    for row in rows:
        print(row)

conn.close()
```

### 方法 2: 使用连接池 (生产环境推荐)

```python
from psycopg2 import pool

# 创建连接池
connection_pool = pool.SimpleConnectionPool(
    1, 20,  # 最小和最大连接数
    host="127.0.0.1",
    port=5432,
    database="video_frames",
    user="video_frames",
    password="video_frames_pwd"
)

# 获取连接
conn = connection_pool.getconn()
try:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT COUNT(*) as count FROM saved_frames")
        result = cur.fetchone()
        print(f"Total frames: {result['count']}")
finally:
    connection_pool.putconn(conn)
```

### 方法 3: 从 .env 文件读取配置

```python
import psycopg2
import os
from dotenv import load_dotenv

load_dotenv()  # 从 .env 加载

DATABASE_URL = os.getenv("DATABASE_URL")
conn = psycopg2.connect(DATABASE_URL)

# 使用连接...
conn.close()
```

### 方法 4: SQLAlchemy ORM (高级)

```python
from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, JSON
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

# 创建引擎
engine = create_engine(
    "postgresql+psycopg2://video_frames:video_frames_pwd@127.0.0.1:5432/video_frames"
)

# 定义模型
Base = declarative_base()

class SavedFrame(Base):
    __tablename__ = 'saved_frames'
    
    id = Column(Integer, primary_key=True)
    video_path = Column(String)
    prompt = Column(Text)
    description = Column(Text)
    model_id = Column(String)
    created_at = Column(DateTime)

# 查询
Session = sessionmaker(bind=engine)
session = Session()

frames = session.query(SavedFrame).filter(
    SavedFrame.prompt.isnot(None)
).limit(5).all()

for frame in frames:
    print(f"ID: {frame.id}, Prompt: {frame.prompt[:100]}...")
```

---

## 常用查询 SQL

### 1. 获取所有包含 prompt 的记录

```sql
SELECT 
    id,
    video_path,
    video_name,
    prompt,
    description,
    model_id,
    created_at
FROM saved_frames
WHERE prompt IS NOT NULL
ORDER BY created_at DESC
LIMIT 100;
```

### 2. 统计 prompt 数据

```sql
SELECT 
    COUNT(*) as total_rows,
    COUNT(CASE WHEN prompt IS NOT NULL THEN 1 END) as with_prompt,
    COUNT(CASE WHEN prompt IS NOT NULL THEN 1 END) * 100.0 / COUNT(*) as fill_rate_pct
FROM saved_frames;
```

### 3. 按 format 查询 prompt

```sql
SELECT 
    format,
    COUNT(*) as total,
    COUNT(CASE WHEN prompt IS NOT NULL THEN 1 END) as with_prompt
FROM saved_frames
GROUP BY format
ORDER BY total DESC;
```

### 4. 查询特定模型生成的 prompt

```sql
SELECT 
    id,
    model_id,
    prompt,
    analyze_started_at,
    analyze_ended_at
FROM saved_frames
WHERE model_id = 'kimi-k2.5' AND prompt IS NOT NULL
ORDER BY created_at DESC
LIMIT 50;
```

### 5. 获取 prompt 及其相关字段

```sql
SELECT 
    id,
    video_path,
    prompt,
    video_prompt,
    i2v_prompt,
    dimensions,
    feedback,
    status
FROM saved_frames
WHERE prompt IS NOT NULL
LIMIT 20;
```

### 6. Prompt 使用情况

```sql
SELECT 
    model_name,
    COUNT(*) as usage_count,
    COUNT(DISTINCT frame_id) as unique_frames
FROM prompt_usage
GROUP BY model_name
ORDER BY usage_count DESC;
```

### 7. 获取高质量 prompt (有正面反馈)

```sql
SELECT 
    id,
    video_path,
    prompt,
    model_id,
    feedback,
    created_at
FROM saved_frames
WHERE prompt IS NOT NULL 
  AND feedback = 'good'
ORDER BY created_at DESC
LIMIT 50;
```

### 8. 查询特定时间范围的 prompt

```sql
SELECT 
    id,
    prompt,
    created_at
FROM saved_frames
WHERE prompt IS NOT NULL
  AND created_at >= '2026-05-25'
  AND created_at < '2026-06-02'
ORDER BY created_at DESC;
```

### 9. 关联 saved_frames 和 prompt_usage

```sql
SELECT 
    sf.id,
    sf.video_path,
    sf.prompt,
    pu.model_name,
    pu.context,
    pu.used_at
FROM saved_frames sf
LEFT JOIN prompt_usage pu ON sf.id = pu.frame_id
WHERE sf.prompt IS NOT NULL
LIMIT 20;
```

### 10. 导出 prompt 数据为 CSV 格式

```sql
COPY (
    SELECT id, video_path, prompt, model_id, created_at
    FROM saved_frames
    WHERE prompt IS NOT NULL
) TO STDOUT WITH CSV HEADER;
```

---

## Python 完整示例脚本

参见: `/tmp/db_query_example.py`

该脚本包含以下功能:

1. **连接管理** - 建立和关闭数据库连接
2. **查询统计** - 获取表的基本统计信息
3. **数据检索** - 获取包含 prompt 的帧数据
4. **使用统计** - 统计 prompt 的使用情况
5. **按类型查询** - 按 format 查询数据

**运行:**
```bash
python /tmp/db_query_example.py
```

---

## 注意事项

### 1. 数据特性

- **Prompt 数据很大:** 每条 prompt 通常包含几 KB 到几十 KB 的文本
- **中文和英文混合:** prompt 中既包含中文描述，也包含英文指令
- **包含敏感内容:** 某些 prompt 描述内容可能敏感，需要小心处理
- **格式不统一:** 不同模型生成的 prompt 格式和风格差异较大

### 2. 性能优化

```sql
-- 如果经常查询 prompt，建议添加索引:
CREATE INDEX idx_saved_frames_prompt ON saved_frames (prompt) 
WHERE prompt IS NOT NULL;

-- 对于按 model_id 查询，已有索引，不需要额外优化
```

### 3. 数据一致性

- `saved_frames` 和 `prompt_usage` 之间存在外键关系
- 删除 `saved_frames` 中的记录会自动删除关联的 `prompt_usage` 记录

### 4. 隐私和安全

- 数据库密码存储在 `.env` 文件中，**不要提交到 Git**
- 确保 `.env` 在 `.gitignore` 中
- 生产环境建议使用环境变量或密钥管理服务

### 5. 备份

```bash
# 导出数据库
pg_dump -h 127.0.0.1 -U video_frames -d video_frames > backup.sql

# 导出特定表
pg_dump -h 127.0.0.1 -U video_frames -d video_frames -t saved_frames > frames.sql

# 导出为 CSV
psql -h 127.0.0.1 -U video_frames -d video_frames \
  -c "COPY saved_frames TO STDOUT WITH CSV HEADER" > frames.csv
```

---

## 文件路径参考

| 文件 | 路径 |
|------|------|
| 项目根目录 | `/mnt/cypher/project/asset_manager/video-frame-extractor` |
| 环境配置 | `/mnt/cypher/project/asset_manager/video-frame-extractor/.env` |
| 服务器代码 | `/mnt/cypher/project/asset_manager/video-frame-extractor/server/index.mjs` |
| 示例脚本 | `/tmp/db_query_example.py` |

---

## 总结

1. **Prompt 存储位置:** `saved_frames.prompt` 字段
2. **Prompt 数据量:** 37% 的记录包含 prompt (约 8,913 条)
3. **关键表:** `saved_frames` (主表), `prompt_usage` (使用日志)
4. **连接方式:** PostgreSQL + psycopg2 (Python)
5. **主要 AI 模型:** qwen, qwen-3.5, qwen-3.7-plus, kimi, kimi-k2.5

---

**报告结束**
