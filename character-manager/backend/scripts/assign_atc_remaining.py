#!/usr/bin/env python3
"""Assign ATC audio candidates to characters with fake/missing voice_id."""
import psycopg2, psycopg2.extras

CHAR_ETH_MAP = {
    'Caucasian': ['Caucasian', 'Caucasian (Mediterranean)', 'Caucasian (Mediterranean descent)', 'Caucasian (Middle Eastern descent)'],
    'Asian': ['Asian', 'Japanese'],
    'Hispanic/Latino': ['Latina', 'Latino', 'Hispanic', 'Hispanic/Latino'],
    'South Asian': ['South Asian'],
    'Middle Eastern': ['Middle Eastern', 'Arab', 'Mediterranean'],
    'African American': ['African American', 'Black/Afro', 'Black'],
    'Mixed': ['Mixed', 'Mixed (Japanese/Caucasian)'],
}

def get_atc_categories(char_eth):
    for group, eths in CHAR_ETH_MAP.items():
        if char_eth in eths:
            return [f"atc_{group.lower().replace(' ', '_').replace('/', '_')}"]
    return ["atc_caucasian"]

conn = psycopg2.connect('postgresql://postgres:YRQ21163x%21ecjoy@db.agnithttoxexijxkksbv.supabase.co:5432/postgres')
cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

cur.execute("""
    SELECT c.id, c.name, c.category, c.attributes->>'Ethnicity' as ethnicity
    FROM characters c
    WHERE (c.is_deleted IS NULL OR c.is_deleted = FALSE)
      AND c.creator_id = 'official'
      AND (c.voice_id IS NULL OR c.voice_id NOT LIKE 'http%%')
      AND NOT EXISTS (
          SELECT 1 FROM audio_library a WHERE a.assigned_to = c.id AND a.status IN ('pending','online')
      )
    ORDER BY c.category, c.name
""")
chars = cur.fetchall()
print(f"Characters needing audio: {len(chars)}")

assigned_total = 0
batch_count = 0

for ch in chars:
    char_eth = ch['ethnicity'] or 'Caucasian'
    cats = get_atc_categories(char_eth)
    placeholders = ','.join(['%s'] * len(cats))

    cur.execute(f"""
        SELECT id FROM audio_library
        WHERE assigned_to IS NULL AND (status IS NULL OR status = '')
          AND oss_url IS NOT NULL AND category IN ({placeholders})
        ORDER BY random() LIMIT 3
    """, cats)
    picks = [r['id'] for r in cur.fetchall()]

    if not picks:
        cur.execute("""
            SELECT id FROM audio_library
            WHERE assigned_to IS NULL AND (status IS NULL OR status = '')
              AND oss_url IS NOT NULL AND category LIKE 'atc_%%'
            ORDER BY random() LIMIT 3
        """)
        picks = [r['id'] for r in cur.fetchall()]

    for aid in picks:
        cur.execute(
            "UPDATE audio_library SET assigned_to = %s, status = 'pending' WHERE id = %s",
            (ch['id'], aid),
        )
    assigned_total += len(picks)
    batch_count += 1

    if batch_count % 50 == 0:
        conn.commit()
        print(f"  committed {batch_count}/{len(chars)} chars, {assigned_total} audio assigned")

conn.commit()
print(f"\nDone! Assigned {assigned_total} audio to {len(chars)} characters")

cur.close()
conn.close()
