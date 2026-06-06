# 快速开始指南 - Character Manager 素材库

## 文件位置

所有素材库文件位置:
```
/mnt/cypher/project/asset_manager/character-manager/backend/scripts/generation_pools/
```

## 1 分钟快速了解

本目录包含 **9 个 JSON 文件** 和 **600+ 个素材元素**，用于生成多样化的真人和动漫角色。

### 文件对应表

| 用途 | 真人角色 | 动漫角色 |
|------|---------|--------|
| 职业 | `occupations_realistic.json` | `occupations_anime.json` |
| 名字 | `names_by_ethnicity.json` | `names_anime.json` |
| 性格 | `personalities.json` (realistic) | `personalities.json` (anime_types) |
| 爱好 | `hobbies.json` (通用) | `hobbies.json` (通用) |
| 体型 | `body_types.json` | `body_types.json` |

## 核心文件概览

### 职业库

**真人职业** (`occupations_realistic.json`):
- 101+ 职业
- 16 个行业分类
- 包含职业描述

**动漫职业** (`occupations_anime.json`):
- 26+ 职业/身份
- 3 个类型分类: school_roles, fantasy_roles, modern_roles

### 名字库

**真人名字** (`names_by_ethnicity.json`):
- 340 个名字 (女 170 + 男 170)
- 8 个种族背景
- 每个种族 30+ 名字

**动漫名字** (`names_anime.json`):
- 女性名字: 60+
- 男性名字: 55+
- 姓氏: 55+ (常见日式姓氏)

### 爱好库 (`hobbies.json`)

196+ 项爱好，分 9 类:
- 运动户外 (35+)
- 艺术创意 (30+)
- 智力兴趣 (30+)
- 音乐表演 (15+)
- 社交社区 (20+)
- 时尚生活 (15+)
- 收藏爱好 (14+)
- 游戏谜题 (20+)
- 自然动物 (15+)

### 性格库 (`personalities.json`)

- 真人性格: 50+
- 动漫性格: 20+ (Tsundere, Kuudere, Yandere 等)

## 使用示例

### Python 加载

```python
import json

# 加载真人职业库
with open('occupations_realistic.json', 'r', encoding='utf-8') as f:
    occupations = json.load(f)

# 加载名字库
with open('names_by_ethnicity.json', 'r', encoding='utf-8') as f:
    names = json.load(f)

# 加载爱好库
with open('hobbies.json', 'r', encoding='utf-8') as f:
    hobbies = json.load(f)

# 随机选择
import random
job = random.choice(list(occupations['medical']))
print(f"职业: {job['title']}")
print(f"描述: {job['description']}")
```

### JavaScript 加载

```javascript
// 异步加载
async function loadPools() {
  const occupations = await fetch('occupations_realistic.json').then(r => r.json());
  const names = await fetch('names_by_ethnicity.json').then(r => r.json());
  const hobbies = await fetch('hobbies.json').then(r => r.json());
  
  return { occupations, names, hobbies };
}

// 随机选择
function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
```

## 数据统计

```
真人职业:      101+
动漫职业:      26+
真人名字:      340 (8个种族)
动漫名字:      170 (名+姓)
爱好:          196+ (9个分类)
性格特征:      71+ (真人50+, 动漫20+)
体型选项:      8
种族背景:      8
关系状态:      4
────────────────────
总计:          600+
```

## 常见操作

### 生成真人角色

```python
import random, json

with open('names_by_ethnicity.json') as f:
    names_pool = json.load(f)
with open('occupations_realistic.json') as f:
    jobs_pool = json.load(f)
with open('hobbies.json') as f:
    hobbies_pool = json.load(f)
with open('personalities.json') as f:
    personalities_pool = json.load(f)

# 1. 选择种族
ethnicity = random.choice(list(names_pool.keys()))

# 2. 选择性别
gender = random.choice(['female', 'male'])

# 3. 获取名字
name = random.choice(names_pool[ethnicity][gender])

# 4. 获取职业
all_jobs = []
for jobs in jobs_pool.values():
    all_jobs.extend(jobs)
job = random.choice(all_jobs)

# 5. 获取爱好 (3个)
hobby_categories = list(hobbies_pool.values())
hobbies = [
    random.choice(hobbies_pool['sports_outdoors']),
    random.choice(hobbies_pool['arts_creative']),
    random.choice(hobbies_pool['intellectual'])
]

# 6. 获取性格
personality = random.choice(personalities_pool['realistic'])

print(f"""
名字: {name}
种族: {ethnicity}
性别: {gender}
职业: {job['title']}
爱好: {', '.join(hobbies)}
性格: {personality}
""")
```

### 生成动漫角色

```python
import random, json

with open('names_anime.json') as f:
    names_pool = json.load(f)
with open('occupations_anime.json') as f:
    jobs_pool = json.load(f)
with open('hobbies.json') as f:
    hobbies_pool = json.load(f)
with open('personalities.json') as f:
    personalities_pool = json.load(f)

# 1. 选择名字 (名 + 姓)
first_name = random.choice(names_pool['female_first_names'])
surname = random.choice(names_pool['surnames'])

# 2. 获取职业/身份
all_jobs = []
for jobs in jobs_pool.values():
    all_jobs.extend(jobs)
job = random.choice(all_jobs)

# 3. 获取爱好
hobbies = [
    random.choice(hobbies_pool['games_puzzles']),
    random.choice(hobbies_pool['arts_creative'])
]

# 4. 获取性格 (动漫类型)
personality = random.choice(personalities_pool['anime_types'])

print(f"""
名字: {first_name} {surname}
身份: {job['title']}
爱好: {', '.join(hobbies)}
性格: {personality}
""")
```

## 文件格式

所有文件都是 UTF-8 编码的 JSON，可直接用任何编程语言解析。

### 职业文件格式

```json
{
  "category": [
    {
      "title": "Job Title",
      "description": "Job description..."
    }
  ]
}
```

### 名字文件格式 (按种族)

```json
{
  "Ethnicity": {
    "female": ["Name1", "Name2"],
    "male": ["Name1", "Name2"]
  }
}
```

### 爱好文件格式

```json
{
  "category": ["Hobby1", "Hobby2", ...]
}
```

## 素材库大小

| 文件 | 大小 |
|------|------|
| occupations_realistic.json | 14 KB |
| occupations_anime.json | 3.2 KB |
| names_by_ethnicity.json | 5.6 KB |
| names_anime.json | 2.4 KB |
| hobbies.json | 4.1 KB |
| personalities.json | 1.7 KB |
| ethnicities.json | 1.7 KB |
| body_types.json | 911 B |
| relationship_status.json | 471 B |
| **总计** | **56 KB** |

## 包含的种族/文化背景

1. Caucasian (欧美白人)
2. Asian_East (东亚)
3. Asian_South (南亚)
4. Asian_Southeast (东南亚)
5. Black_AfricanAmerican (黑人/非裔美国人)
6. Hispanic_Latino (拉丁裔)
7. MiddleEastern (中东)
8. Mixed (混血)

## 包含的行业 (真人)

1. Medical (医疗)
2. Legal (法律)
3. Education (教育)
4. Technology (技术)
5. Arts & Entertainment (艺术娱乐)
6. Sports & Fitness (体育健身)
7. Food & Beverage (食品饮料)
8. Fashion & Beauty (时尚美容)
9. Finance & Business (财务商业)
10. Media & Communications (媒体传播)
11. Architecture & Construction (建筑施工)
12. Agriculture & Environment (农业环保)
13. Military & Security (军事安全)
14. Aviation & Maritime (航空海事)
15. Science & Research (科学研究)
16. Other (其他)

## 动漫性格类型

- Tsundere (傲娇)
- Kuudere (高冷)
- Yandere (病娇)
- Dandere (隐蔽)
- Deredere (热情)
- Himedere (公主气)
- Kamidere (傲慢)
- Mayadere (神秘)
- Oujidere (王子气)
- Shundere (郁闷)
- 以及其他 10+ 种

## 体型选项

1. Slim (苗条)
2. Athletic (运动型)
3. Curvy (丰满)
4. Petite (娇小)
5. Average (普通)
6. Muscular (肌肉型)
7. Tall (高挑)
8. Fit (健美)

## 关系状态

1. Single (单身)
2. None (未指定)
3. It's complicated (复杂关系)
4. Just got out of a relationship (刚分手)

## 详细文档

查看 `README.md` 了解更详细的使用说明和高级示例。

查看 `/INVESTIGATION_REPORT.md` 了解完整的数据收集和构建过程。

---

**最后更新**: 2026年6月6日  
**项目**: Character Manager 批量角色生成  
**维护者**: Research Agent

