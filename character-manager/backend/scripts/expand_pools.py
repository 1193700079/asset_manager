#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
expand_pools.py

Batch-expand the JSON material pools under
``character-manager/backend/scripts/generation_pools/`` from the current
~924 entries to the thousands/tens-of-thousands range using the Qwen3
model (``qwen3-235b-a22b``) via DashScope's OpenAI-compatible endpoint.

Usage
-----
    python expand_pools.py --all
    python expand_pools.py --pool names
    python expand_pools.py --pool occupations --pool hobbies

Pool keys: ``names`` (covers ``names_by_ethnicity`` + ``names_anime``),
``occupations`` (realistic + anime), ``hobbies``, ``personalities``,
``ethnicities``, ``body_types``, ``relationship_status``.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable, Iterable

try:
    from openai import OpenAI
except ImportError:  # pragma: no cover
    print("[FATAL] openai package not installed. Run: pip install openai", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_API_KEY = "sk-f06ed67897c44811b526ee41e5c9319a"
MODEL = "qwen3-235b-a22b"

POOL_DIR = Path(__file__).resolve().parent / "generation_pools"
REQUEST_DELAY = 0.5            # seconds between successful calls
MAX_RETRIES = 3
INITIAL_BACKOFF = 2.0          # seconds (exponential)

API_KEY = os.environ.get("DASHSCOPE_API_KEY") or DEFAULT_API_KEY
client = OpenAI(api_key=API_KEY, base_url=BASE_URL)


# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------
def log(msg: str) -> None:
    print(f"[expand_pools] {msg}", flush=True)


def log_pool(pool: str, msg: str) -> None:
    print(f"[expand_pools][{pool}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Qwen API caller (with retry + exponential backoff)
# ---------------------------------------------------------------------------
def call_qwen(
    user_prompt: str,
    system_prompt: str = "You are a meticulous data generator. Always reply with VALID JSON only — no markdown fences, no commentary.",
    temperature: float = 0.9,
    max_tokens: int = 4096,
) -> str:
    """Call Qwen with retries; return raw text content."""
    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = client.chat.completions.create(
                model=MODEL,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=temperature,
                max_tokens=max_tokens,
                extra_body={
                    "chat.completion.no_think": True,
                    "enable_thinking": False,
                },
            )
            time.sleep(REQUEST_DELAY)
            content = resp.choices[0].message.content or ""
            return content.strip()
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            backoff = INITIAL_BACKOFF * (2 ** (attempt - 1)) + random.uniform(0, 0.5)
            log(f"API call failed (attempt {attempt}/{MAX_RETRIES}): {exc!r}. Retrying in {backoff:.1f}s...")
            time.sleep(backoff)
    raise RuntimeError(f"Qwen API failed after {MAX_RETRIES} retries: {last_error!r}")


# ---------------------------------------------------------------------------
# JSON parsing helpers
# ---------------------------------------------------------------------------
_JSON_FENCE_RE = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.DOTALL | re.IGNORECASE)


def strip_fences(text: str) -> str:
    text = text.strip()
    m = _JSON_FENCE_RE.match(text)
    if m:
        return m.group(1).strip()
    # In case fences appear at start only
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?", "", text, count=1).strip()
        if text.endswith("```"):
            text = text[:-3].strip()
    return text


def parse_json_lenient(text: str) -> Any:
    """Try strict json.loads; fall back to first JSON-looking substring."""
    cleaned = strip_fences(text)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    # Find first '{' or '[' and last matching bracket
    for opener, closer in (("[", "]"), ("{", "}")):
        start = cleaned.find(opener)
        end = cleaned.rfind(closer)
        if 0 <= start < end:
            try:
                return json.loads(cleaned[start : end + 1])
            except json.JSONDecodeError:
                continue
    raise ValueError(f"Cannot parse JSON from response: {text[:300]}")


# ---------------------------------------------------------------------------
# File IO
# ---------------------------------------------------------------------------
def load_pool(filename: str) -> Any:
    path = POOL_DIR / filename
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_pool(filename: str, data: Any) -> None:
    path = POOL_DIR / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    log_pool(filename, f"saved -> {path}")


# ---------------------------------------------------------------------------
# Dedup helpers (preserve order, case-insensitive for strings)
# ---------------------------------------------------------------------------
def dedup_strings(items: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for it in items:
        if not isinstance(it, str):
            continue
        key = it.strip().casefold()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(it.strip())
    return out


def dedup_dicts(items: Iterable[dict], key_field: str) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        k = str(it.get(key_field, "")).strip().casefold()
        if not k or k in seen:
            continue
        seen.add(k)
        out.append(it)
    return out


# ---------------------------------------------------------------------------
# Generic batch-runner
# ---------------------------------------------------------------------------
def run_until_target(
    label: str,
    fetch_batch: Callable[[int], list],
    current: list,
    dedup: Callable[[Iterable], list],
    target: int,
    max_iters: int = 80,
) -> list:
    """Repeatedly call ``fetch_batch(iter_idx)`` and merge until ``target`` reached."""
    items = dedup(current)
    log_pool(label, f"start: {len(items)} -> target {target}")
    for i in range(max_iters):
        if len(items) >= target:
            break
        try:
            new_batch = fetch_batch(i)
        except Exception as exc:  # noqa: BLE001
            log_pool(label, f"batch {i} failed: {exc!r}")
            continue
        before = len(items)
        items = dedup(items + (new_batch or []))
        log_pool(label, f"batch {i}: +{len(items) - before} (total {len(items)})")
        if len(items) - before == 0 and i > 5:
            log_pool(label, "no new items in this batch; continuing with higher randomness")
    log_pool(label, f"done: {len(items)} items")
    return items


# ---------------------------------------------------------------------------
# Pool 1: names_by_ethnicity.json
# ---------------------------------------------------------------------------
ETHNICITY_GROUPS: list[dict] = [
    {"name": "Caucasian", "hint": "general European-American (English, German, French, Italian) names"},
    {"name": "Asian_East", "hint": "Chinese, Japanese, and Korean given names (romanized)"},
    {"name": "Asian_South", "hint": "Indian, Pakistani, Bangladeshi, Sri Lankan given names"},
    {"name": "Asian_Southeast", "hint": "Thai, Vietnamese, Filipino, Indonesian, Malaysian given names"},
    {"name": "Black_AfricanAmerican", "hint": "African-American common given names"},
    {"name": "African", "hint": "Sub-Saharan African given names (Nigerian, Kenyan, Ethiopian, Ghanaian, South African)"},
    {"name": "Hispanic_Latino", "hint": "Spanish and Latin American (Mexican, Colombian, Argentinian, Cuban) given names"},
    {"name": "MiddleEastern", "hint": "Arabic, Turkish, Persian Middle-Eastern given names"},
    {"name": "Slavic", "hint": "Russian, Polish, Ukrainian, Czech, Serbian given names (romanized)"},
    {"name": "Nordic", "hint": "Swedish, Norwegian, Danish, Finnish, Icelandic given names"},
    {"name": "Celtic", "hint": "Irish, Scottish, Welsh, Gaelic given names"},
    {"name": "Mediterranean", "hint": "Italian, Greek, Portuguese, Spanish given names"},
    {"name": "Jewish", "hint": "Hebrew, Yiddish, Israeli given names"},
    {"name": "Persian", "hint": "Iranian / Persian given names (romanized)"},
    {"name": "Pacific_Islander", "hint": "Hawaiian, Samoan, Maori, Fijian, Tongan given names"},
    {"name": "Native_American", "hint": "Native American / Indigenous North American given names"},
    {"name": "Latino_Brazilian", "hint": "Brazilian Portuguese given names"},
    {"name": "Korean", "hint": "Korean given names (romanized, Revised Romanization)"},
    {"name": "Vietnamese", "hint": "Vietnamese given names with diacritics"},
    {"name": "Mixed", "hint": "Modern unisex / mixed-heritage / nature-inspired given names"},
]


def expand_names_by_ethnicity(target_total: int = 3000, per_group_target: int = 110) -> None:
    fname = "names_by_ethnicity.json"
    data = load_pool(fname) or {}

    # Make sure every group exists
    for grp in ETHNICITY_GROUPS:
        data.setdefault(grp["name"], {"female": [], "male": []})
        for sex in ("female", "male"):
            data[grp["name"]].setdefault(sex, [])

    grand_total = lambda: sum(  # noqa: E731
        len(data[g["name"]]["female"]) + len(data[g["name"]]["male"]) for g in ETHNICITY_GROUPS
    )

    for grp in ETHNICITY_GROUPS:
        for sex in ("female", "male"):
            label = f"{fname}:{grp['name']}/{sex}"
            existing = data[grp["name"]][sex]

            def fetch(i: int, _grp=grp, _sex=sex, _existing=existing) -> list[str]:
                avoid_sample = random.sample(_existing, k=min(40, len(_existing))) if _existing else []
                avoid_str = ", ".join(avoid_sample) if avoid_sample else "(none yet)"
                prompt = (
                    f"Generate exactly 40 REAL, culturally-authentic {_sex} given names for the "
                    f"'{_grp['name']}' group ({_grp['hint']}).\n"
                    "Rules:\n"
                    "- Use names that real people actually have (no invented/fantasy names).\n"
                    "- Romanize non-Latin scripts using common romanization (e.g. Pinyin, Revised Romanization, Hepburn).\n"
                    "- Mix common, uncommon, classic and modern names; avoid duplicates within the list.\n"
                    f"- Avoid these names already in the pool: {avoid_str}.\n"
                    f"- Random seed for diversity: {random.randint(1000, 9999)}-{i}.\n"
                    'Reply with a single JSON array of strings, e.g. ["Alice","Bob",...]. Nothing else.'
                )
                raw = call_qwen(prompt)
                arr = parse_json_lenient(raw)
                if not isinstance(arr, list):
                    raise ValueError(f"Expected list, got {type(arr).__name__}")
                return [str(x).strip() for x in arr if isinstance(x, (str, int))]

            data[grp["name"]][sex] = run_until_target(
                label, fetch, existing, dedup_strings, per_group_target, max_iters=2
            )

        # Persist progressively after each ethnicity group
        save_pool(fname, data)
        log_pool(fname, f"running grand total: {grand_total()}")

        if grand_total() >= target_total:
            log_pool(fname, f"reached grand total target {target_total}, stopping early")
            break

    save_pool(fname, data)
    log_pool(fname, f"FINAL grand total: {grand_total()}")


# ---------------------------------------------------------------------------
# Pool 2: names_anime.json
# ---------------------------------------------------------------------------
def expand_names_anime(female_target: int = 520, male_target: int = 520, surnames_target: int = 320) -> None:
    fname = "names_anime.json"
    data = load_pool(fname) or {"female_first_names": [], "male_first_names": [], "surnames": []}

    specs = [
        ("female_first_names", "female Japanese given names typical of anime/manga characters", female_target),
        ("male_first_names", "male Japanese given names typical of anime/manga characters", male_target),
        ("surnames", "Japanese family names (surnames) commonly found in anime/manga", surnames_target),
    ]

    for key, hint, target in specs:
        existing = data.get(key, [])

        def fetch(i: int, _hint=hint, _existing=existing) -> list[str]:
            avoid_sample = random.sample(_existing, k=min(40, len(_existing))) if _existing else []
            avoid_str = ", ".join(avoid_sample) if avoid_sample else "(none yet)"
            prompt = (
                f"Generate exactly 80 distinct {_hint}.\n"
                "Rules:\n"
                "- Use Hepburn romanization (no kanji), but you MAY use macrons (ō, ū) for long vowels.\n"
                "- Use names that real Japanese people actually have OR that frequently appear in mainstream anime/manga.\n"
                "- Mix classical, modern, cute and cool styles. No fantasy gibberish.\n"
                f"- Avoid these already in the pool: {avoid_str}.\n"
                f"- Random seed: {random.randint(1000, 9999)}-{i}.\n"
                'Reply with a JSON array of strings only.'
            )
            raw = call_qwen(prompt)
            arr = parse_json_lenient(raw)
            if not isinstance(arr, list):
                raise ValueError("Expected list")
            return [str(x).strip() for x in arr if isinstance(x, (str, int))]

        data[key] = run_until_target(f"{fname}:{key}", fetch, existing, dedup_strings, target, max_iters=25)
        save_pool(fname, data)

    save_pool(fname, data)


# ---------------------------------------------------------------------------
# Pool 3: occupations_realistic.json
# ---------------------------------------------------------------------------
REALISTIC_INDUSTRIES: list[dict] = [
    {"key": "medical", "hint": "healthcare and medical professions"},
    {"key": "legal", "hint": "law, justice and legal services"},
    {"key": "education", "hint": "education, teaching and academic professions"},
    {"key": "technology", "hint": "software, IT, AI, data and computing professions"},
    {"key": "arts_entertainment", "hint": "fine arts, film, theater and entertainment industry roles"},
    {"key": "sports_fitness", "hint": "professional sports, coaching and fitness"},
    {"key": "food_beverage", "hint": "culinary, restaurant and beverage industry roles"},
    {"key": "fashion_beauty", "hint": "fashion design, modeling and beauty/cosmetics professions"},
    {"key": "finance_business", "hint": "finance, accounting, business management and consulting"},
    {"key": "media_communications", "hint": "journalism, broadcasting, content and PR professions"},
    {"key": "architecture_construction", "hint": "architecture, engineering and construction trades"},
    {"key": "agriculture_environment", "hint": "agriculture, environment, conservation and ecology"},
    {"key": "military_security", "hint": "military, law enforcement, private security and emergency services"},
    {"key": "aviation_maritime", "hint": "aviation, aerospace, maritime and shipping professions"},
    {"key": "science_research", "hint": "scientific research across natural and social sciences"},
    {"key": "transportation_logistics", "hint": "transport, logistics, warehousing and supply-chain roles"},
    {"key": "hospitality_tourism", "hint": "hotels, tourism, travel and hospitality service roles"},
    {"key": "manufacturing_industrial", "hint": "factory, manufacturing and industrial production roles"},
    {"key": "retail_sales", "hint": "retail, sales, e-commerce and merchandising roles"},
    {"key": "real_estate", "hint": "real estate, property management and development"},
    {"key": "government_public", "hint": "government, civil service and public administration"},
    {"key": "nonprofit_charity", "hint": "nonprofit, NGO, charity and humanitarian work"},
    {"key": "gaming_esports", "hint": "video games, esports, streaming and game industry roles"},
    {"key": "beauty_wellness", "hint": "spa, wellness, holistic health and personal-care services"},
    {"key": "automotive", "hint": "automotive industry, mechanics, motorsport and vehicle design"},
    {"key": "energy_utilities", "hint": "energy, oil & gas, renewables, utilities and power industry"},
    {"key": "telecommunications", "hint": "telecom, networking and communications infrastructure roles"},
    {"key": "biotech_pharma", "hint": "biotechnology, pharmaceuticals and life-science industry"},
    {"key": "social_services", "hint": "social work, counseling, human services and community support"},
    {"key": "religious_spiritual", "hint": "religious, clerical and spiritual leadership roles"},
    {"key": "skilled_trades", "hint": "skilled manual trades (plumbing, electrical, carpentry, welding)"},
    {"key": "other", "hint": "miscellaneous modern professions not covered above"},
]


def expand_occupations_realistic(per_industry: int = 28) -> None:
    fname = "occupations_realistic.json"
    data = load_pool(fname) or {}
    for ind in REALISTIC_INDUSTRIES:
        data.setdefault(ind["key"], [])

    for ind in REALISTIC_INDUSTRIES:
        existing = data[ind["key"]]
        existing_titles = [it.get("title", "") for it in existing if isinstance(it, dict)]

        def fetch(i: int, _ind=ind, _titles=existing_titles) -> list[dict]:
            avoid_sample = random.sample(_titles, k=min(20, len(_titles))) if _titles else []
            avoid_str = ", ".join(avoid_sample) if avoid_sample else "(none yet)"
            prompt = (
                f"Generate exactly 25 distinct, realistic occupations in the field of "
                f"'{_ind['key']}' ({_ind['hint']}).\n"
                "Rules:\n"
                "- Each item must be a JSON object with two string fields: 'title' and 'description'.\n"
                "- 'description' must be one or two concise sentences (15-35 words) covering core duties and typical workplace.\n"
                "- Mix traditional and modern roles, juniors and specialists, common and niche jobs.\n"
                f"- Avoid these existing titles: {avoid_str}.\n"
                f"- Random seed: {random.randint(1000, 9999)}-{i}.\n"
                'Reply with a JSON array of objects only, e.g. [{"title":"...","description":"..."}].'
            )
            raw = call_qwen(prompt, max_tokens=4096)
            arr = parse_json_lenient(raw)
            if not isinstance(arr, list):
                raise ValueError("Expected list")
            cleaned: list[dict] = []
            for x in arr:
                if isinstance(x, dict) and x.get("title") and x.get("description"):
                    cleaned.append({"title": str(x["title"]).strip(), "description": str(x["description"]).strip()})
            return cleaned

        data[ind["key"]] = run_until_target(
            f"{fname}:{ind['key']}",
            fetch,
            existing,
            lambda items: dedup_dicts(items, "title"),
            per_industry,
            max_iters=4,
        )
        save_pool(fname, data)

    save_pool(fname, data)
    total = sum(len(v) for v in data.values() if isinstance(v, list))
    log_pool(fname, f"FINAL grand total: {total}")


# ---------------------------------------------------------------------------
# Pool 4: occupations_anime.json
# ---------------------------------------------------------------------------
ANIME_CATEGORIES: list[dict] = [
    {"key": "school_roles", "hint": "anime/manga school-life roles, clubs, committees and student archetypes"},
    {"key": "fantasy_roles", "hint": "anime fantasy archetypes (mages, knights, demons, kemonomimi etc.)"},
    {"key": "modern_roles", "hint": "modern-setting anime/manga character occupations (idols, streamers, shop staff)"},
    {"key": "isekai_roles", "hint": "isekai/RPG-style classes (adventurer, summoner, dragon-tamer, guild master)"},
    {"key": "mecha_scifi_roles", "hint": "mecha and sci-fi anime occupations (mech pilot, AI navigator, space marine)"},
    {"key": "supernatural_roles", "hint": "supernatural anime roles (exorcist, shrine maiden, onmyoji, hunter, demon slayer)"},
    {"key": "slice_of_life_roles", "hint": "slice-of-life anime everyday roles (bakery worker, bookstore clerk, ramen apprentice)"},
    {"key": "yakuza_underworld_roles", "hint": "yakuza, underworld and delinquent anime archetypes"},
]


def expand_occupations_anime(per_category: int = 30) -> None:
    fname = "occupations_anime.json"
    data = load_pool(fname) or {}
    for cat in ANIME_CATEGORIES:
        data.setdefault(cat["key"], [])

    for cat in ANIME_CATEGORIES:
        existing = data[cat["key"]]
        existing_titles = [it.get("title", "") for it in existing if isinstance(it, dict)]

        def fetch(i: int, _cat=cat, _titles=existing_titles) -> list[dict]:
            avoid_sample = random.sample(_titles, k=min(15, len(_titles))) if _titles else []
            avoid_str = ", ".join(avoid_sample) if avoid_sample else "(none yet)"
            prompt = (
                f"Generate exactly 25 distinct anime/manga character occupations or archetypes for the category "
                f"'{_cat['key']}' ({_cat['hint']}).\n"
                "Rules:\n"
                "- Each item must be a JSON object with 'title' and 'description'.\n"
                "- 'description' is one short sentence (10-25 words) capturing the role and personality flavor.\n"
                "- Embrace anime tropes; mix classic and modern.\n"
                f"- Avoid: {avoid_str}.\n"
                f"- Seed: {random.randint(1000, 9999)}-{i}.\n"
                "Reply with a JSON array of objects only."
            )
            raw = call_qwen(prompt)
            arr = parse_json_lenient(raw)
            if not isinstance(arr, list):
                raise ValueError("Expected list")
            cleaned: list[dict] = []
            for x in arr:
                if isinstance(x, dict) and x.get("title") and x.get("description"):
                    cleaned.append({"title": str(x["title"]).strip(), "description": str(x["description"]).strip()})
            return cleaned

        data[cat["key"]] = run_until_target(
            f"{fname}:{cat['key']}",
            fetch,
            existing,
            lambda items: dedup_dicts(items, "title"),
            per_category,
            max_iters=3,
        )
        save_pool(fname, data)

    save_pool(fname, data)
    total = sum(len(v) for v in data.values() if isinstance(v, list))
    log_pool(fname, f"FINAL grand total: {total}")


# ---------------------------------------------------------------------------
# Pool 5: hobbies.json
# ---------------------------------------------------------------------------
HOBBY_CATEGORIES: list[dict] = [
    {"key": "sports_outdoors", "hint": "outdoor sports, athletic and adventure hobbies"},
    {"key": "arts_creative", "hint": "visual arts, crafts and creative making hobbies"},
    {"key": "intellectual", "hint": "intellectual, academic, study-oriented hobbies"},
    {"key": "music_performance", "hint": "music playing, singing and performance hobbies"},
    {"key": "social_community", "hint": "social, community, party and group hobbies"},
    {"key": "fashion_lifestyle", "hint": "fashion, beauty, lifestyle and home hobbies"},
    {"key": "collections_hobbies", "hint": "collecting hobbies (cards, coins, memorabilia, vintage items)"},
    {"key": "games_puzzles", "hint": "video games, board games, puzzles and tabletop hobbies"},
    {"key": "nature_animals", "hint": "nature observation, pets and animal-related hobbies"},
    {"key": "cooking_culinary", "hint": "cooking, baking, food culture and beverage hobbies"},
    {"key": "technology_gadgets", "hint": "technology, electronics, DIY tech and gadget hobbies"},
    {"key": "wellness_meditation", "hint": "mindfulness, meditation, wellness and spiritual hobbies"},
    {"key": "performing_arts", "hint": "theater, dance, comedy, performing arts and stage hobbies"},
    {"key": "writing_literature", "hint": "writing, journaling, blogging, literary hobbies"},
    {"key": "automotive_mechanical", "hint": "cars, motorcycles, mechanical and DIY repair hobbies"},
    {"key": "water_activities", "hint": "swimming, sailing, surfing, diving and water-based hobbies"},
    {"key": "travel_exploration", "hint": "travel, urban exploration, cultural exploration hobbies"},
    {"key": "esoteric_spiritual", "hint": "tarot, astrology, esoteric and spiritual practice hobbies"},
    {"key": "photography_video", "hint": "photography, videography, cinematography hobbies"},
    {"key": "fitness_bodybuilding", "hint": "gym, weightlifting, calisthenics, bodybuilding hobbies"},
]


def expand_hobbies(per_category: int = 90) -> None:
    fname = "hobbies.json"
    data = load_pool(fname) or {}
    for cat in HOBBY_CATEGORIES:
        data.setdefault(cat["key"], [])

    for cat in HOBBY_CATEGORIES:
        existing = data[cat["key"]]

        def fetch(i: int, _cat=cat, _existing=existing) -> list[str]:
            avoid_sample = random.sample(_existing, k=min(30, len(_existing))) if _existing else []
            avoid_str = ", ".join(avoid_sample) if avoid_sample else "(none yet)"
            prompt = (
                f"Generate exactly 70 specific, distinct hobbies in the category "
                f"'{_cat['key']}' ({_cat['hint']}).\n"
                "Rules:\n"
                "- Each hobby must be a SHORT phrase (1-5 words), specific not generic.\n"
                "- Prefer concrete activities (e.g. 'Bonsai trimming') over vague ones (e.g. 'Plants').\n"
                "- Mix beginner, intermediate, niche and trending hobbies.\n"
                f"- Avoid these already in the pool: {avoid_str}.\n"
                f"- Seed: {random.randint(1000, 9999)}-{i}.\n"
                "Reply with a JSON array of strings only."
            )
            raw = call_qwen(prompt)
            arr = parse_json_lenient(raw)
            if not isinstance(arr, list):
                raise ValueError("Expected list")
            return [str(x).strip() for x in arr if isinstance(x, (str, int))]

        data[cat["key"]] = run_until_target(
            f"{fname}:{cat['key']}", fetch, existing, dedup_strings, per_category, max_iters=4
        )
        save_pool(fname, data)

    save_pool(fname, data)
    total = sum(len(v) for v in data.values() if isinstance(v, list))
    log_pool(fname, f"FINAL grand total: {total}")


# ---------------------------------------------------------------------------
# Pool 6: personalities.json
# ---------------------------------------------------------------------------
def expand_personalities(realistic_target: int = 320, anime_target: int = 210) -> None:
    fname = "personalities.json"
    data = load_pool(fname) or {"realistic": [], "anime_types": []}
    data.setdefault("realistic", [])
    data.setdefault("anime_types", [])

    # Realistic: 2-3 sentence descriptions
    existing_realistic = data["realistic"]

    def fetch_realistic(i: int) -> list[str]:
        avoid_sample = random.sample(existing_realistic, k=min(15, len(existing_realistic))) if existing_realistic else []
        avoid_str = " | ".join(avoid_sample) if avoid_sample else "(none yet)"
        prompt = (
            "Generate exactly 30 realistic, nuanced personality descriptions for fictional human characters.\n"
            "Rules:\n"
            "- Each entry must be a STRING containing 2-3 sentences (40-90 words total).\n"
            "- Capture core traits, social tendencies, emotional pattern, quirks; avoid clichés.\n"
            "- Each entry must read as a unique character archetype.\n"
            f"- Avoid overlap with: {avoid_str}.\n"
            f"- Seed: {random.randint(1000, 9999)}-{i}.\n"
            "Reply with a JSON array of strings only."
        )
        raw = call_qwen(prompt, max_tokens=4096)
        arr = parse_json_lenient(raw)
        if not isinstance(arr, list):
            raise ValueError("Expected list")
        return [str(x).strip() for x in arr if isinstance(x, str) and len(x.strip()) > 30]

    data["realistic"] = run_until_target(
        f"{fname}:realistic",
        fetch_realistic,
        existing_realistic,
        lambda items: dedup_strings(items),
        realistic_target,
        max_iters=12,
    )
    save_pool(fname, data)

    # Anime: dere-types and archetypes with parenthetical explanation
    existing_anime = data["anime_types"]

    def fetch_anime(i: int) -> list[str]:
        avoid_sample = random.sample(existing_anime, k=min(20, len(existing_anime))) if existing_anime else []
        avoid_str = " | ".join(avoid_sample) if avoid_sample else "(none yet)"
        prompt = (
            "Generate exactly 30 anime-style personality archetypes ('-dere' types and other tropes).\n"
            "Rules:\n"
            "- Format each as: 'ArchetypeName (short English explanation in 5-15 words)'.\n"
            "- Mix classic dere types (tsundere, kuudere, yandere etc.) and broader anime tropes "
            "(genki, dojikko, ojou-sama, shounen protagonist, mentor-figure, rival, antihero etc.).\n"
            "- Each must be unique and meaningfully different from others.\n"
            f"- Avoid: {avoid_str}.\n"
            f"- Seed: {random.randint(1000, 9999)}-{i}.\n"
            "Reply with a JSON array of strings only."
        )
        raw = call_qwen(prompt)
        arr = parse_json_lenient(raw)
        if not isinstance(arr, list):
            raise ValueError("Expected list")
        return [str(x).strip() for x in arr if isinstance(x, str) and x.strip()]

    data["anime_types"] = run_until_target(
        f"{fname}:anime_types",
        fetch_anime,
        existing_anime,
        lambda items: dedup_strings(items),
        anime_target,
        max_iters=10,
    )
    save_pool(fname, data)


# ---------------------------------------------------------------------------
# Pool 7: ethnicities.json
# ---------------------------------------------------------------------------
def expand_ethnicities(target: int = 24) -> None:
    fname = "ethnicities.json"
    data = load_pool(fname) or {"categories": []}
    data.setdefault("categories", [])

    existing = data["categories"]
    existing_names = [it.get("name", "") for it in existing if isinstance(it, dict)]

    def fetch(i: int) -> list[dict]:
        avoid_str = ", ".join(existing_names) if existing_names else "(none yet)"
        prompt = (
            "Generate exactly 15 distinct ethnicity / cultural-heritage categories suitable for character creation.\n"
            "Rules:\n"
            "- Each item is a JSON object with three fields: 'name' (PascalCase or with underscores), "
            "'description' (one sentence), 'regions' (JSON array of 2-6 region/country strings).\n"
            "- Cover global diversity: Europe, Africa, Asia (East/South/Southeast/Central), Middle East, "
            "Americas, Oceania, Indigenous peoples, mixed heritage.\n"
            f"- Avoid these names already used: {avoid_str}.\n"
            f"- Seed: {random.randint(1000, 9999)}-{i}.\n"
            "Reply with a JSON array of objects only."
        )
        raw = call_qwen(prompt)
        arr = parse_json_lenient(raw)
        if not isinstance(arr, list):
            raise ValueError("Expected list")
        cleaned: list[dict] = []
        for x in arr:
            if (
                isinstance(x, dict)
                and x.get("name")
                and x.get("description")
                and isinstance(x.get("regions"), list)
            ):
                cleaned.append(
                    {
                        "name": str(x["name"]).strip(),
                        "description": str(x["description"]).strip(),
                        "regions": [str(r).strip() for r in x["regions"] if isinstance(r, (str, int))],
                    }
                )
        return cleaned

    data["categories"] = run_until_target(
        f"{fname}:categories",
        fetch,
        existing,
        lambda items: dedup_dicts(items, "name"),
        target,
        max_iters=4,
    )
    save_pool(fname, data)


# ---------------------------------------------------------------------------
# Pool 8: body_types.json
# ---------------------------------------------------------------------------
def _slugify(text: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "_", text.strip().lower())
    return s.strip("_")


def expand_body_types(target: int = 32) -> None:
    fname = "body_types.json"
    data = load_pool(fname) or {"types": []}
    data.setdefault("types", [])
    existing = data["types"]
    existing_ids = [it.get("id", "") for it in existing if isinstance(it, dict)]
    existing_names = [it.get("name", "") for it in existing if isinstance(it, dict)]

    def fetch(i: int) -> list[dict]:
        avoid_str = ", ".join(existing_names) if existing_names else "(none yet)"
        prompt = (
            "Generate exactly 20 distinct human body-type descriptors usable for character creation.\n"
            "Rules:\n"
            "- Each item is a JSON object with 'id' (lowercase snake_case), 'name' (display name), "
            "'description' (one short sentence describing build, muscle/fat distribution, height vibe).\n"
            "- Cover both male and female applicable types; mix common, athletic, plus-size, classical "
            "(hourglass, pear, rectangle, inverted triangle, apple), petite, tall, lanky, stocky, etc.\n"
            f"- Avoid these existing names: {avoid_str}.\n"
            f"- Seed: {random.randint(1000, 9999)}-{i}.\n"
            "Reply with a JSON array of objects only."
        )
        raw = call_qwen(prompt)
        arr = parse_json_lenient(raw)
        if not isinstance(arr, list):
            raise ValueError("Expected list")
        cleaned: list[dict] = []
        for x in arr:
            if isinstance(x, dict) and x.get("name") and x.get("description"):
                _id = str(x.get("id") or _slugify(x["name"])).strip()
                if _id in existing_ids:
                    continue
                cleaned.append(
                    {
                        "id": _id,
                        "name": str(x["name"]).strip(),
                        "description": str(x["description"]).strip(),
                    }
                )
        return cleaned

    data["types"] = run_until_target(
        f"{fname}:types",
        fetch,
        existing,
        lambda items: dedup_dicts(items, "id"),
        target,
        max_iters=4,
    )
    save_pool(fname, data)


# ---------------------------------------------------------------------------
# Pool 9: relationship_status.json
# ---------------------------------------------------------------------------
def expand_relationship_status(target: int = 18) -> None:
    fname = "relationship_status.json"
    data = load_pool(fname) or {"statuses": []}
    data.setdefault("statuses", [])
    existing = data["statuses"]
    existing_names = [it.get("name", "") for it in existing if isinstance(it, dict)]
    existing_ids = [it.get("id", "") for it in existing if isinstance(it, dict)]

    def fetch(i: int) -> list[dict]:
        avoid_str = ", ".join(existing_names) if existing_names else "(none yet)"
        prompt = (
            "Generate exactly 18 distinct relationship-status options for character profiles.\n"
            "Rules:\n"
            "- Each item is a JSON object with 'id' (lowercase snake_case), 'name' (display name), "
            "'description' (one short sentence).\n"
            "- Cover the spectrum: single, dating, engaged, married, divorced, widowed, separated, "
            "polyamorous, open relationship, friends with benefits, long-distance, situationship, "
            "newlywed, partnered, betrothed (anime), arranged-marriage etc.\n"
            f"- Avoid: {avoid_str}.\n"
            f"- Seed: {random.randint(1000, 9999)}-{i}.\n"
            "Reply with a JSON array of objects only."
        )
        raw = call_qwen(prompt)
        arr = parse_json_lenient(raw)
        if not isinstance(arr, list):
            raise ValueError("Expected list")
        cleaned: list[dict] = []
        for x in arr:
            if isinstance(x, dict) and x.get("name") and x.get("description"):
                _id = str(x.get("id") or _slugify(x["name"])).strip()
                if _id in existing_ids:
                    continue
                cleaned.append(
                    {
                        "id": _id,
                        "name": str(x["name"]).strip(),
                        "description": str(x["description"]).strip(),
                    }
                )
        return cleaned

    data["statuses"] = run_until_target(
        f"{fname}:statuses",
        fetch,
        existing,
        lambda items: dedup_dicts(items, "id"),
        target,
        max_iters=3,
    )
    save_pool(fname, data)


# ---------------------------------------------------------------------------
# Dispatch table
# ---------------------------------------------------------------------------
POOL_RUNNERS: dict[str, Callable[[], None]] = {
    "names_by_ethnicity": lambda: expand_names_by_ethnicity(target_total=3000, per_group_target=60),
    "names_anime": lambda: expand_names_anime(),
    "occupations_realistic": lambda: expand_occupations_realistic(),
    "occupations_anime": lambda: expand_occupations_anime(),
    "hobbies": lambda: expand_hobbies(),
    "personalities": lambda: expand_personalities(),
    "ethnicities": lambda: expand_ethnicities(),
    "body_types": lambda: expand_body_types(),
    "relationship_status": lambda: expand_relationship_status(),
}

POOL_ALIASES: dict[str, list[str]] = {
    "names": ["names_by_ethnicity", "names_anime"],
    "occupations": ["occupations_realistic", "occupations_anime"],
    "hobbies": ["hobbies"],
    "personalities": ["personalities"],
    "ethnicities": ["ethnicities"],
    "body_types": ["body_types"],
    "relationship_status": ["relationship_status"],
    "all": list(POOL_RUNNERS.keys()),
}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="Expand character generation material pools using Qwen3-235B.")
    parser.add_argument(
        "--pool",
        action="append",
        default=[],
        help=f"Pool name or alias to expand. May be supplied multiple times. "
             f"Choices: {sorted(set(list(POOL_RUNNERS.keys()) + list(POOL_ALIASES.keys())))}",
    )
    parser.add_argument("--all", action="store_true", help="Expand every pool")
    args = parser.parse_args()

    if args.all and not args.pool:
        targets = POOL_ALIASES["all"]
    elif args.pool:
        targets = []
        for p in args.pool:
            if p in POOL_RUNNERS:
                targets.append(p)
            elif p in POOL_ALIASES:
                targets.extend(POOL_ALIASES[p])
            else:
                log(f"Unknown pool '{p}', skipping")
        # preserve order, dedup
        seen: set[str] = set()
        targets = [t for t in targets if not (t in seen or seen.add(t))]
    else:
        parser.print_help()
        sys.exit(0)

    log(f"Expanding pools: {targets}")
    log(f"Using API key prefix: {API_KEY[:8]}*** ; model: {MODEL}")

    failures: list[tuple[str, str]] = []
    for name in targets:
        runner = POOL_RUNNERS[name]
        log(f"=== START pool '{name}' ===")
        t0 = time.time()
        try:
            runner()
            log(f"=== DONE pool '{name}' in {time.time() - t0:.1f}s ===")
        except Exception as exc:  # noqa: BLE001
            log(f"!!! FAILED pool '{name}': {exc!r}")
            failures.append((name, repr(exc)))

    log("===== SUMMARY =====")
    if failures:
        for n, e in failures:
            log(f"  FAIL: {n}: {e}")
    else:
        log("  All pools expanded successfully.")


if __name__ == "__main__":
    main()
