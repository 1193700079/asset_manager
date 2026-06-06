"""一次性脚本：将角色 Sora Iwasaki (id=976) 的 category 从 anime_male 改为 anime_female。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import psycopg2
from config import settings


def main() -> None:
    dsn = settings.ecjoy_database_url
    with psycopg2.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, name, category FROM characters WHERE id=%s AND name=%s",
                (976, "Sora Iwasaki"),
            )
            row = cur.fetchone()
            if not row:
                print("未找到 id=976 且 name='Sora Iwasaki' 的记录，未做任何修改。")
                return
            print(f"修改前: id={row[0]}, name={row[1]}, category={row[2]}")

            cur.execute(
                """
                UPDATE characters
                SET category=%s
                WHERE id=%s AND name=%s AND category=%s
                """,
                ("anime_female", 976, "Sora Iwasaki", "anime_male"),
            )
            print(f"UPDATE 影响行数: {cur.rowcount}")

            cur.execute(
                "SELECT id, name, category FROM characters WHERE id=%s",
                (976,),
            )
            after = cur.fetchone()
            print(f"修改后: id={after[0]}, name={after[1]}, category={after[2]}")
            assert after[2] == "anime_female", "校验失败：category 未变为 anime_female"
        conn.commit()
    print("已提交。")


if __name__ == "__main__":
    main()
