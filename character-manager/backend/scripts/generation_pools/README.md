# Character Manager 批量角色生成素材库

本目录包含 Character Manager 项目批量角色生成功能所需的结构化素材库，支持真人角色（girlfriend/boyfriend）和动漫角色（anime_female/anime_male）的多维度生成。

## 文件清单

### 1. 职业库

#### `occupations_realistic.json` - 真人职业库
- **结构**: 按行业分类 (medical, legal, education, technology, arts_entertainment 等 16 个分类)
- **包含**: 101+ 多样化职业
- **内容**: 每个职业包含 `title`（职业名称）和 `description`（工作描述）
- **用途**: 为真人角色（girlfriend/boyfriend）生成职业背景故事

**示例**:
```json
{
  "medical": [
    {
      "title": "Doctor (Physician)",
      "description": "Diagnoses and treats patient illnesses and injuries..."
    }
  ]
}
```

#### `occupations_anime.json` - 动漫职业/身份库
- **结构**: 按角色类型分类 (school_roles, fantasy_roles, modern_roles)
- **包含**: 26+ 动漫常见职业/身份设定
- **内容**: 学园类、幻想类、现代类等各种角色设定
- **用途**: 为动漫角色（anime_female/anime_male）生成身份设定

### 2. 名字库

#### `names_by_ethnicity.json` - 按种族分类的真人名字库
- **结构**: 按种族分类 (Caucasian, Asian_East, Asian_South, Black_AfricanAmerican, Hispanic_Latino, MiddleEastern, Mixed)
- **包含**: 
  - 每个种族 30+ 女性名字
  - 每个种族 30+ 男性名字
  - 总计 170 女性名字 + 170 男性名字
- **用途**: 为真人角色生成多种族背景的真实名字

**示例**:
```json
{
  "Caucasian": {
    "female": ["Emma", "Sophia", "Olivia", ...],
    "male": ["James", "Robert", "Michael", ...]
  }
}
```

#### `names_anime.json` - 日式动漫名字库
- **结构**: 三个部分
  - `female_first_names`: 60+ 女性名字 (Sakura, Yuki, Hana 等)
  - `male_first_names`: 55+ 男性名字 (Hiroshi, Takeshi, Kaito 等)
  - `surnames`: 55+ 日式姓氏 (Tanaka, Suzuki, Yamamoto 等)
- **用途**: 为动漫角色生成日式名字组合

### 3. 爱好库

#### `hobbies.json` - 多分类爱好库
- **结构**: 9 个分类
  - `sports_outdoors`: 运动户外 (35+ 项目)
  - `arts_creative`: 艺术创意 (30+ 项目)
  - `intellectual`: 智力兴趣 (30+ 项目)
  - `music_performance`: 音乐表演 (15+ 项目)
  - `social_community`: 社交社区 (20+ 项目)
  - `fashion_lifestyle`: 时尚生活 (15+ 项目)
  - `collections_hobbies`: 收藏爱好 (14+ 项目)
  - `games_puzzles`: 游戏谜题 (20+ 项目)
  - `nature_animals`: 自然动物 (15+ 项目)
- **总计**: 196+ 多样化爱好
- **用途**: 随机选择为角色分配爱好

### 4. 性格特征库

#### `personalities.json` - 真人与动漫性格库
- **结构**: 两个部分
  - `realistic`: 50+ 真人性格描述词
    - Charming, Mysterious, Adventurous, Nurturing, Confident 等
    - 适合约会应用中的角色描述
  - `anime_types`: 20+ 动漫性格类型
    - Tsundere, Kuudere, Yandere 等日式性格类型
    - 每个类型包含简短描述
- **用途**: 为角色分配性格特征

### 5. 其他选项库

#### `ethnicities.json` - 种族/文化背景选项
- **结构**: categories 数组，包含 8 个种族/文化背景
- **内容**: 每个背景包含
  - `name`: 背景名称
  - `description`: 描述
  - `regions`: 相关地区列表
- **用途**: 定义可选的背景选项

#### `body_types.json` - 体型选项
- **结构**: types 数组，包含 8 种体型
- **内容**:
  - Slim, Athletic, Curvy, Petite
  - Average, Muscular, Tall, Fit
- **各体型**: 包含 id, name, description
- **用途**: 为角色分配体型属性

#### `relationship_status.json` - 关系状态
- **结构**: statuses 数组，包含 4 种关系状态
- **内容**:
  - Single (单身)
  - None (未指定)
  - It's complicated (复杂关系)
  - Just got out of a relationship (刚分手)
- **用途**: 定义角色的关系状态选项

## 使用示例

### Python 中使用

```python
import json
from pathlib import Path

# 加载素材库
pools_dir = Path("generation_pools")

# 加载真人职业库
with open(pools_dir / "occupations_realistic.json") as f:
    occupations = json.load(f)

# 随机选择职业
import random
all_jobs = []
for category, jobs in occupations.items():
    all_jobs.extend(jobs)

random_job = random.choice(all_jobs)
print(f"职业: {random_job['title']}")
print(f"描述: {random_job['description']}")

# 加载名字库
with open(pools_dir / "names_by_ethnicity.json") as f:
    names = json.load(f)

# 随机选择种族和名字
ethnicity = random.choice(list(names.keys()))
gender = random.choice(["male", "female"])
name = random.choice(names[ethnicity][gender])

# 加载爱好库
with open(pools_dir / "hobbies.json") as f:
    hobbies = json.load(f)

# 随机选择多个爱好
selected_hobbies = []
for category in hobbies.values():
    selected_hobbies.append(random.choice(category))

# 构建完整角色
character = {
    "name": name,
    "ethnicity": ethnicity,
    "occupation": random_job,
    "hobbies": selected_hobbies[:3],  # 选择前3个
    "gender": gender,
}
```

### 批量生成示例

```python
def generate_batch_characters(count: int, char_type: str = "girlfriend"):
    """
    批量生成角色
    
    Args:
        count: 生成数量
        char_type: 角色类型 ("girlfriend" | "boyfriend" | "anime_female" | "anime_male")
    
    Returns:
        生成的角色列表
    """
    characters = []
    
    # 根据类型选择使用的素材库
    if char_type in ["girlfriend", "boyfriend"]:
        # 使用真人素材库
        for _ in range(count):
            character = generate_realistic_character(char_type)
            characters.append(character)
    else:
        # 使用动漫素材库
        for _ in range(count):
            character = generate_anime_character(char_type)
            characters.append(character)
    
    return characters
```

## 素材库统计

| 类型 | 数量 |
|------|------|
| 真人职业 | 101+ |
| 动漫职业/身份 | 26+ |
| 真人名字 (女性) | 170 |
| 真人名字 (男性) | 170 |
| 动漫女性名字 | 60+ |
| 动漫男性名字 | 55+ |
| 动漫姓氏 | 55+ |
| 爱好 | 196+ |
| 性格特征 | 71+ |
| 体型选项 | 8 |
| 关系状态 | 4 |
| 种族/文化背景 | 8 |

## 设计原则

1. **多样性**: 每个维度都包含充足的选项，确保生成的角色具有足够的多样性
2. **真实性**: 所有数据基于现实生活或常见的动漫设定，确保生成结果的合理性
3. **可扩展性**: JSON 格式易于维护和扩展，可随时添加新的选项
4. **跨文化**: 包含多种文化和种族背景，体现包容性
5. **分类清晰**: 数据按逻辑分类，便于不同的生成策略使用

## 注意事项

- **真人角色** (girlfriend/boyfriend): 优先使用 `occupations_realistic.json`, `names_by_ethnicity.json`, `personalities.json` 中的 realistic 部分
- **动漫角色** (anime_female/anime_male): 优先使用 `occupations_anime.json`, `names_anime.json`, `personalities.json` 中的 anime_types 部分
- **爱好与性格**: 两种角色类型都可以使用 `hobbies.json`, 但性格应根据角色类型选择相应部分
- **文化敏感性**: 在使用种族/文化背景时，应确保尊重多样性并避免刻板印象

## 后续扩展建议

1. 添加更多行业和职业
2. 添加更多语言的名字库（中文、韩文、阿拉伯文等）
3. 添加角色的背景故事模板
4. 添加服装风格、发型选择等视觉属性
5. 添加性格特征的兼容性匹配数据

