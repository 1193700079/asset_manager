"""Character batch generation service.

Shared by:
  - scripts/batch_generate_characters.py (CLI)
  - routers/batch_generate.py            (HTTP API)

Responsibilities:
  - Load material pools from `generation_pools/*.json` (with built-in fallback)
  - Build category-aware prompts for `qwen3-235b-a22b`
  - Call DashScope OpenAI-compatible chat completion + retry
  - Validate generated character schema
"""
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# --- 常量 ---------------------------------------------------------------------
VALID_CATEGORIES = ("girlfriend", "boyfriend", "anime_female", "anime_male")
REQUIRED_ATTR_KEYS = (
    "Age", "Body", "Hobbies", "Language",
    "Ethnicity", "Occupation", "Personality", "Relationship",
)

DEFAULT_MODEL = "qwen3-235b-a22b"
DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"

# 默认素材池兜底（当 generation_pools/*.json 缺失或为空时使用）。
# 数据简短、保守、安全；正式素材会由研究阶段补全后覆盖。
BUILTIN_POOLS: dict[str, dict[str, list[str]]] = {
    "occupations": {
        "girlfriend": [
            "Fashion Model", "Nurse", "High School Teacher", "Lawyer",
            "Painter", "Pastry Chef", "Software Engineer", "Photographer",
            "Yoga Instructor", "Veterinarian", "Architect", "Florist",
        ],
        "boyfriend": [
            "Mechanical Engineer", "Professional Athlete", "Firefighter",
            "Startup Founder", "Jazz Musician", "Bartender", "Carpenter",
            "Surgeon", "Architect", "Pilot", "Police Detective",
        ],
        "anime_female": [
            "Student Council President", "Magical Girl", "Catgirl Cafe Maid",
            "Idol Trainee", "Shrine Maiden", "Light Novel Writer",
            "Demon Hunter", "Mecha Pilot",
        ],
        "anime_male": [
            "Kendo Club Captain", "Transfer Student", "Vampire Prince",
            "Demon Lord (Reformed)", "Ace Detective", "Battle Mage",
            "Rookie Hero", "Mecha Pilot",
        ],
    },
    "ethnicities": {
        "girlfriend": ["Caucasian", "Asian", "Latina", "Black",
                      "Middle Eastern", "Mixed"],
        "boyfriend":  ["Caucasian", "Asian", "Latino", "Black",
                      "Middle Eastern", "Mixed"],
        "anime_female": ["Japanese", "Korean", "Chinese", "Fantasy"],
        "anime_male":   ["Japanese", "Korean", "Chinese", "Fantasy"],
    },
    "personalities": {
        "common": [
            "calm and analytical", "warm and nurturing",
            "playful and witty", "quiet and observant",
            "ambitious and driven",
        ],
        "anime_female": ["tsundere", "kuudere", "genki", "yandere",
                         "dandere", "deredere"],
        "anime_male":   ["chuuni", "stoic swordsman", "hot-blooded",
                         "smug genius", "gentle prince"],
    },
    "body_types": {
        "girlfriend": ["Slim", "Athletic", "Curvy", "Petite", "Average"],
        "boyfriend":  ["Athletic", "Muscular", "Slim", "Average", "Tall"],
        "anime_female": ["Slim", "Petite", "Athletic", "Curvy"],
        "anime_male":   ["Athletic", "Slim", "Tall", "Muscular"],
    },
    "hobbies": {
        "common": [
            "reading", "cooking", "hiking", "photography", "painting",
            "gaming", "playing guitar", "chess", "yoga", "anime",
            "running", "baking",
        ],
    },
    "name_styles": {
        "anime_female": ["Sakura Tanaka", "Yuki Shimizu", "Hina Mori",
                         "Rin Kobayashi"],
        "anime_male":   ["Haruto Sato", "Ren Takahashi", "Kaito Yamada",
                         "Sora Iwasaki"],
    },
    "settings_themes": {
        "girlfriend": ["coastal town", "Parisian arts district", "Tokyo suburb"],
        "boyfriend":  ["coastal town", "Brooklyn loft", "alpine ski resort"],
        "anime_female": ["academy city", "magical forest", "post-war Tokyo"],
        "anime_male":   ["academy city", "demon realm", "futuristic colony"],
    },
}


# --- 素材池 -------------------------------------------------------------------
@dataclass
class Pools:
    occupations: dict[str, list[str]] = field(default_factory=dict)
    ethnicities: dict[str, list[str]] = field(default_factory=dict)
    personalities: dict[str, list[str]] = field(default_factory=dict)
    body_types: dict[str, list[str]] = field(default_factory=dict)
    hobbies: dict[str, list[str]] = field(default_factory=dict)
    name_styles: dict[str, list[str]] = field(default_factory=dict)
    settings_themes: dict[str, list[str]] = field(default_factory=dict)

    @classmethod
    def load(cls, pool_dir: Path | None) -> "Pools":
        """从 pool_dir 读取 7 个池文件；缺失或解析失败时回退到 BUILTIN_POOLS。"""
        files = {
            "occupations":   "occupation_pool",
            "ethnicities":   "ethnicity_pool",
            "personalities": "personality_pool",
            "body_types":    "body_pool",
            "hobbies":       "hobby_pool",
            "name_styles":   "name_pool",
            "settings_themes": "setting_pool",
        }

        def _read(field_key: str, fname: str) -> dict[str, list[str]]:
            if pool_dir is not None:
                fp = pool_dir / f"{fname}.json"
                if fp.exists():
                    try:
                        data = json.loads(fp.read_text(encoding="utf-8"))
                        if isinstance(data, dict) and data:
                            return data
                    except Exception as e:  # noqa: BLE001
                        print(f"[pool] {fp.name} parse failed: {e}")
            return BUILTIN_POOLS.get(field_key, {})

        return cls(**{k: _read(k, v) for k, v in files.items()})

    def slice_for(self, category: str) -> dict[str, list[str]]:
        def pick(d: dict[str, list[str]]) -> list[str]:
            out: list[str] = []
            for k in (category, "common"):
                if k in d:
                    out.extend(d[k])
            return out
        return {
            "occupations":   pick(self.occupations),
            "ethnicities":   pick(self.ethnicities),
            "personalities": pick(self.personalities),
            "body_types":    pick(self.body_types),
            "hobbies":       pick(self.hobbies),
            "name_styles":   pick(self.name_styles),
            "settings_themes": pick(self.settings_themes),
        }


# --- DashScope client ---------------------------------------------------------
def get_dashscope_api_key() -> str:
    key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if key:
        return key
    # pydantic-settings 也会读取 .env，预留字段
    try:
        from config import settings  # local import to avoid hard dep at import time
        key = (getattr(settings, "dashscope_api_key", "") or "").strip()
        if key:
            return key
    except Exception:
        pass
    raise RuntimeError(
        "DASHSCOPE_API_KEY is not configured (env or backend/.env)"
    )


def build_qwen_client(base_url: str = DEFAULT_BASE_URL,
                      api_key: str | None = None):
    from openai import OpenAI
    return OpenAI(api_key=api_key or get_dashscope_api_key(),
                  base_url=base_url)


# --- Prompt 构建 --------------------------------------------------------------
SYSTEM_PROMPT = (
    "You are a creative character designer for a roleplay/companion app. "
    "Generate diverse, vivid, internally consistent characters in strict JSON. "
    "Output MUST be a single JSON object with key 'characters' whose value is "
    "a JSON array. Do not include markdown fences or commentary."
)

_CATEGORY_BRIEF = {
    "girlfriend": (
        "Realistic adult women (18-35), diverse ethnicities and professions. "
        "Names should match each ethnicity."
    ),
    "boyfriend": (
        "Realistic adult men (20-40), diverse ethnicities and professions. "
        "Names should match each ethnicity."
    ),
    "anime_female": (
        "Anime-style young women. Japanese / Korean / Chinese or fantasy "
        "names. Tropes welcome (tsundere, kuudere, genki, magical girl, "
        "catgirl, student council, etc.)."
    ),
    "anime_male": (
        "Anime-style young men. Japanese / Korean / Chinese or fantasy "
        "names. Tropes welcome (chuuni, dandere, yandere, hot-blooded, "
        "vampire prince, swordsman, etc.)."
    ),
}


def build_user_prompt(category: str, n: int,
                      pool_slice: dict[str, list[str]],
                      avoid_names: list[str]) -> str:
    pool_block = json.dumps(pool_slice, ensure_ascii=False, indent=2)
    avoid_block = ", ".join(avoid_names[-200:]) if avoid_names else "(none)"
    brief = _CATEGORY_BRIEF[category]
    return f"""Generate {n} characters for category: {category}.

Brief: {brief}

Use the material pool below for inspiration. Mix and match; do NOT copy a
single field verbatim. Ensure diversity across the batch (no two characters
share the same ethnicity AND occupation).

Material pool (JSON):
{pool_block}

Avoid these names (already used): {avoid_block}

Required schema for EACH character (English only, except names where
appropriate):
{{
  "name": "<First Last>",
  "category": "{category}",
  "description": "2-3 sentences of background, written in third person.",
  "attributes": {{
    "Age": "<number as string>",
    "Body": "Slim|Athletic|Curvy|Petite|Average|Muscular|Tall",
    "Hobbies": "<comma-separated, 2-4 items>",
    "Language": "English|Japanese|Korean|Mandarin|...",
    "Ethnicity": "<one ethnicity>",
    "Occupation": "<specific job title>",
    "Personality": "1-2 sentences describing personality.",
    "Relationship": "None|Single|It's complicated|..."
  }}
}}

Return JSON object: {{"characters": [ ...{n} items... ]}}.
"""


# --- AI 调用 + 解析 -----------------------------------------------------------
_JSON_OBJECT_RE = re.compile(r"\{[\s\S]*\}")


def _extract_json(text: str) -> Any:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*", "", text).strip()
        if text.endswith("```"):
            text = text[:-3].strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = _JSON_OBJECT_RE.search(text)
        if not m:
            raise
        return json.loads(m.group(0))


def call_qwen(client, model: str, system_prompt: str, user_prompt: str,
              max_retries: int = 3, temperature: float = 0.9) -> list[dict]:
    last_err: Exception | None = None
    for attempt in range(1, max_retries + 1):
        try:
            resp = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user",   "content": user_prompt},
                ],
                temperature=temperature,
                response_format={"type": "json_object"},
            )
            content = resp.choices[0].message.content or ""
            data = _extract_json(content)
            chars = data.get("characters") if isinstance(data, dict) else None
            if not isinstance(chars, list) or not chars:
                raise ValueError("response missing 'characters' array")
            return chars
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(2 * attempt)
    raise RuntimeError(f"Qwen call failed after {max_retries} retries: {last_err!r}")


# --- 校验 ---------------------------------------------------------------------
def validate_character(c: Any, category: str) -> tuple[bool, str]:
    if not isinstance(c, dict):
        return False, "not an object"
    for k in ("name", "description", "attributes"):
        if not c.get(k):
            return False, f"missing {k}"
    if c.get("category") and c["category"] != category:
        return False, f"category mismatch ({c['category']})"
    attrs = c["attributes"]
    if not isinstance(attrs, dict):
        return False, "attributes not an object"
    for k in REQUIRED_ATTR_KEYS:
        if not attrs.get(k):
            return False, f"attributes missing {k}"
    name = str(c["name"]).strip()
    if len(name) < 2 or len(name) > 64:
        return False, f"abnormal name length: {name!r}"
    return True, ""


# --- 生成主循环 ---------------------------------------------------------------
def generate_for_category(
    client,
    *,
    category: str,
    count: int,
    batch_size: int,
    pool_slice: dict[str, list[str]],
    avoid_names: set[str],
    model: str = DEFAULT_MODEL,
    on_progress=None,
) -> list[dict]:
    """Generate `count` characters for a category, batched + dedup-by-name."""
    if category not in VALID_CATEGORIES:
        raise ValueError(f"invalid category: {category}")
    out: list[dict] = []
    avoid_list = list(avoid_names)
    while len(out) < count:
        need = min(batch_size, count - len(out))
        prompt = build_user_prompt(category, need, pool_slice, avoid_list)
        try:
            raw = call_qwen(client, model, SYSTEM_PROMPT, prompt)
        except Exception as e:  # noqa: BLE001
            if on_progress:
                on_progress({"event": "batch_failed", "error": str(e)})
            break
        for c in raw:
            ok, why = validate_character(c, category)
            if not ok:
                continue
            name = str(c["name"]).strip()
            if name in avoid_names:
                continue
            c["category"] = category
            out.append(c)
            avoid_names.add(name)
            avoid_list.append(name)
            if len(out) >= count:
                break
        if on_progress:
            on_progress({"event": "progress",
                         "category": category,
                         "done": len(out),
                         "total": count})
    return out
