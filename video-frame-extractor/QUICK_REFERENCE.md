# PostgreSQL 数据库 - 快速参考

## 连接信息 (Quick Copy)

```
HOST:     127.0.0.1
PORT:     5432
DB:       video_frames
USER:     video_frames
PASSWORD: video_frames_pwd
```

**连接字符串:**
```
postgres://video_frames:video_frames_pwd@127.0.0.1:5432/video_frames
```

---

## 数据库表概览

| 表名 | 行数 | 用途 |
|------|------|------|
| **saved_frames** | 23,918 | 主表，存储帧和 prompt 数据 |
| **prompt_usage** | 3,362 | 记录 prompt 使用日志 |
| **prescreen_feedback** | 若干 | 预筛选反馈 |
| **prescreen_history** | 若干 | 批处理历史 |

---

## Prompt 字段速查

| 字段 | 类型 | 数据量 | 说明 |
|------|------|--------|------|
| **prompt** | TEXT | 8,913 条 (37%) | 图片描述 prompt |
| **video_prompt** | TEXT | 8 条 | 文生视频 prompt |
| **i2v_prompt** | TEXT | 8 条 | 图生视频 prompt |

---

## 最常用 SQL 查询

### 1. 获取最近的 prompt

```sql
SELECT id, video_path, prompt, model_id, created_at 
FROM saved_frames 
WHERE prompt IS NOT NULL 
ORDER BY created_at DESC 
LIMIT 10;
```

### 2. 统计 prompt 数据

```sql
SELECT COUNT(*) as total, COUNT(CASE WHEN prompt IS NOT NULL THEN 1 END) as with_prompt 
FROM saved_frames;
```

### 3. 按模型查询

```sql
SELECT id, prompt, model_id, created_at 
FROM saved_frames 
WHERE model_id = 'kimi-k2.5' AND prompt IS NOT NULL 
LIMIT 20;
```

### 4. 获取特定记录详情

```sql
SELECT * FROM saved_frames WHERE id = 100;
```

---

## Python 快速连接

### 最小化代码

```python
import psycopg2

conn = psycopg2.connect(
    "dbname=video_frames user=video_frames password=video_frames_pwd host=127.0.0.1"
)
cur = conn.cursor()

# 查询 prompt 数据
cur.execute("SELECT id, prompt FROM saved_frames WHERE prompt IS NOT NULL LIMIT 5")
for row in cur.fetchall():
    print(row)

cur.close()
conn.close()
```

### 使用 .env

```python
import psycopg2
from dotenv import load_dotenv
import os

load_dotenv()
conn = psycopg2.connect(os.getenv("DATABASE_URL"))
cur = conn.cursor()
# ... 使用连接 ...
```

---

## 命令行查询

### 列出所有表
```bash
PGPASSWORD="video_frames_pwd" psql -h 127.0.0.1 -U video_frames -d video_frames -c "\dt"
```

### 查看表结构
```bash
PGPASSWORD="video_frames_pwd" psql -h 127.0.0.1 -U video_frames -d video_frames -c "\d saved_frames"
```

### 执行简单查询
```bash
PGPASSWORD="video_frames_pwd" psql -h 127.0.0.1 -U video_frames -d video_frames -c "SELECT COUNT(*) FROM saved_frames;"
```

### 导出为 CSV
```bash
PGPASSWORD="video_frames_pwd" psql -h 127.0.0.1 -U video_frames -d video_frames \
  -c "COPY saved_frames TO STDOUT WITH CSV HEADER" > frames.csv
```

---

## 关键事实

- **Prompt 主要存储:** `saved_frames.prompt`
- **数据量:** ~37% 的行有 prompt
- **主要模型:** qwen, kimi (及其变体)
- **时间范围:** 记录从 2026-05-25 至 2026-06-02
- **最大 prompt 长度:** 几 KB 到几十 KB (中英混合)

---

## 文件位置

- 完整报告: `/mnt/cypher/project/asset_manager/video-frame-extractor/PostgreSQL_数据库调查报告.md`
- Python 示例: `/mnt/cypher/project/asset_manager/video-frame-extractor/db_query_example.py`
- 项目代码: `/mnt/cypher/project/asset_manager/video-frame-extractor/server/index.mjs`

---

**最后更新:** 2026-06-02
