#!/usr/bin/env python3
"""
PostgreSQL 连接示例脚本 - video-frame-extractor 项目
================================================

数据库连接信息:
- Host: 127.0.0.1
- Port: 5432
- Database: video_frames
- User: video_frames
- Password: video_frames_pwd

数据库表结构:
1. saved_frames - 主要存储标注后的帧数据和prompt
2. prompt_usage - 记录prompt的使用日志
3. prescreen_feedback - 预筛选反馈数据
4. prescreen_history - 预筛选历史记录
"""

import psycopg2
from psycopg2.extras import RealDictCursor
import os
from dotenv import load_dotenv

# 从 .env 文件加载配置
load_dotenv()

# 数据库连接配置
DB_CONFIG = {
    'host': '127.0.0.1',
    'port': 5432,
    'database': 'video_frames',
    'user': 'video_frames',
    'password': 'video_frames_pwd'
}

# 或者从 DATABASE_URL 解析
# DATABASE_URL = "postgres://video_frames:video_frames_pwd@127.0.0.1:5432/video_frames"

class PromptDB:
    """PostgreSQL 数据库操作类"""
    
    def __init__(self, db_config=None):
        """初始化数据库连接"""
        self.db_config = db_config or DB_CONFIG
        self.conn = None
        
    def connect(self):
        """建立数据库连接"""
        try:
            self.conn = psycopg2.connect(**self.db_config)
            print("✓ 数据库连接成功")
            return self.conn
        except Exception as e:
            print(f"✗ 数据库连接失败: {e}")
            return None
    
    def close(self):
        """关闭数据库连接"""
        if self.conn:
            self.conn.close()
            print("✓ 数据库连接已关闭")
    
    def get_frames_with_prompt(self, limit=10):
        """获取包含prompt的帧数据"""
        try:
            with self.conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""
                    SELECT 
                        id,
                        video_path,
                        video_name,
                        timestamp,
                        prompt,
                        video_prompt,
                        i2v_prompt,
                        description,
                        format,
                        status,
                        model_id,
                        created_at
                    FROM saved_frames
                    WHERE prompt IS NOT NULL
                    ORDER BY created_at DESC
                    LIMIT %s
                """, (limit,))
                
                rows = cur.fetchall()
                return rows
        except Exception as e:
            print(f"✗ 查询失败: {e}")
            return None
    
    def get_frame_by_id(self, frame_id):
        """通过ID获取单条帧数据"""
        try:
            with self.conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""
                    SELECT * FROM saved_frames WHERE id = %s
                """, (frame_id,))
                return cur.fetchone()
        except Exception as e:
            print(f"✗ 查询失败: {e}")
            return None
    
    def get_prompt_usage_stats(self):
        """获取prompt使用统计"""
        try:
            with self.conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""
                    SELECT 
                        model_name,
                        COUNT(*) as usage_count,
                        COUNT(DISTINCT frame_id) as unique_frames
                    FROM prompt_usage
                    GROUP BY model_name
                    ORDER BY usage_count DESC
                """)
                return cur.fetchall()
        except Exception as e:
            print(f"✗ 查询失败: {e}")
            return None
    
    def get_saved_frames_stats(self):
        """获取saved_frames表统计信息"""
        try:
            with self.conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""
                    SELECT 
                        COUNT(*) as total_rows,
                        COUNT(CASE WHEN prompt IS NOT NULL THEN 1 END) as rows_with_prompt,
                        COUNT(CASE WHEN prompt IS NOT NULL THEN 1 END) * 100.0 / COUNT(*) as prompt_fill_rate_pct,
                        COUNT(CASE WHEN video_prompt IS NOT NULL THEN 1 END) as rows_with_video_prompt,
                        COUNT(CASE WHEN i2v_prompt IS NOT NULL THEN 1 END) as rows_with_i2v_prompt,
                        COUNT(DISTINCT format) as distinct_formats
                    FROM saved_frames
                """)
                return cur.fetchone()
        except Exception as e:
            print(f"✗ 查询失败: {e}")
            return None
    
    def get_frames_by_format(self, format_name, limit=10):
        """按format查询帧数据"""
        try:
            with self.conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""
                    SELECT 
                        id,
                        video_path,
                        prompt,
                        description,
                        status,
                        model_id
                    FROM saved_frames
                    WHERE format = %s
                    ORDER BY created_at DESC
                    LIMIT %s
                """, (format_name, limit))
                return cur.fetchall()
        except Exception as e:
            print(f"✗ 查询失败: {e}")
            return None


def main():
    """主函数演示"""
    db = PromptDB()
    
    # 连接数据库
    if not db.connect():
        return
    
    try:
        # 1. 获取表统计信息
        print("\n=== 1. saved_frames 表统计 ===")
        stats = db.get_saved_frames_stats()
        if stats:
            for key, value in stats.items():
                print(f"  {key}: {value}")
        
        # 2. 获取带有prompt的帧数据样例
        print("\n=== 2. 包含 prompt 的帧数据 (前5条) ===")
        frames = db.get_frames_with_prompt(limit=5)
        if frames:
            for i, frame in enumerate(frames, 1):
                print(f"\n  记录 {i}:")
                print(f"    ID: {frame['id']}")
                print(f"    Video: {frame['video_name']}")
                print(f"    Format: {frame['format']}")
                print(f"    Status: {frame['status']}")
                print(f"    Model: {frame['model_id']}")
                if frame['prompt']:
                    prompt_preview = frame['prompt'][:100] + "..." if len(frame['prompt']) > 100 else frame['prompt']
                    print(f"    Prompt (preview): {prompt_preview}")
        
        # 3. 获取prompt使用统计
        print("\n=== 3. Prompt 使用统计 ===")
        usage_stats = db.get_prompt_usage_stats()
        if usage_stats:
            for stat in usage_stats:
                print(f"  {stat['model_name']}: {stat['usage_count']} 次 ({stat['unique_frames']} 个唯一帧)")
        
        # 4. 查询具体格式的帧数据
        print("\n=== 4. 不同 format 的帧统计 ===")
        for fmt in ['image_annotation', 'image_prescreen', 'jpeg']:
            frames = db.get_frames_by_format(fmt, limit=1)
            if frames:
                print(f"  {fmt}: 存在")
        
    finally:
        db.close()


if __name__ == '__main__':
    main()
