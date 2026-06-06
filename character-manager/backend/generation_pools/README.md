# generation_pools/

Material pools used as inspiration when calling Qwen3-235B-A22B for batch
character generation. Consumed by:

- `services/character_generator.py::Pools.load`
- `routers/batch_generate.py` (HTTP API: `POST /api/generation/characters`)
- `scripts/batch_generate_characters.py` (CLI)

## File layout

Drop one or more of the following JSON files into this directory. Each file is
optional; missing files fall back to `BUILTIN_POOLS` defined in
`services/character_generator.py`.

| File | Purpose |
|------|---------|
| `occupation_pool.json` | Job titles per category |
| `ethnicity_pool.json`  | Ethnicities per category |
| `personality_pool.json`| Personality traits / anime tropes |
| `body_pool.json`       | Body type vocabulary |
| `hobby_pool.json`      | Hobby strings |
| `name_pool.json`       | Sample names per category (style hint) |
| `setting_pool.json`    | Background / setting themes |

## Schema

Each file is a flat JSON object whose keys are category buckets. Recognised
buckets:

- `girlfriend`, `boyfriend`, `anime_female`, `anime_male` — category-specific
- `common` — merged into every category

Values are arrays of short English strings.

```json
{
  "girlfriend": ["Fashion Model", "Nurse", "Architect"],
  "boyfriend":  ["Mechanical Engineer", "Firefighter"],
  "anime_female": ["Student Council President"],
  "common": ["Photographer"]
}
```

## How they are used

At generation time, the code merges the category-specific bucket with the
`common` bucket and injects the result into the user prompt as a JSON block
labelled `Material pool`. Qwen is instructed to mix and match — not copy
verbatim — so a small but well-curated pool is preferable to a long shallow
list.

Replace these files with research-backed data when ready; no code changes are
required.
