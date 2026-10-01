"""Apply migrations/*.sql in filename order. `{EMBED_DIM}` is substituted from config."""

import asyncio
import logging
from pathlib import Path

import asyncpg

from .config import get_settings
from .ingest import derive
from .models import CandidateProfile
from .skills import SkillNormalizer, load_seed, save_learned

log = logging.getLogger(__name__)

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "migrations"


async def migrate(database_url: str | None = None) -> list[str]:
    settings = get_settings()
    conn = await asyncpg.connect(database_url or settings.database_url)
    applied: list[str] = []
    try:
        await conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations "
            "(name text PRIMARY KEY, applied_at timestamptz DEFAULT now())"
        )
        done = {r["name"] for r in await conn.fetch("SELECT name FROM schema_migrations")}
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if path.name in done:
                continue
            sql = path.read_text(encoding="utf-8").replace("{EMBED_DIM}", str(settings.embed_dim))
            async with conn.transaction():
                await conn.execute(sql)
                await conn.execute("INSERT INTO schema_migrations (name) VALUES ($1)", path.name)
            applied.append(path.name)
            log.info("applied migration %s", path.name)
        # Seed file is the source of truth for built-in aliases; re-running updates them.
        seed = load_seed()
        await conn.executemany(
            "INSERT INTO skill_synonyms (alias, canonical, source) VALUES ($1, $2, 'seed')"
            " ON CONFLICT (alias) DO UPDATE SET canonical = EXCLUDED.canonical, source = 'seed'",
            list(seed.items()),
        )
        log.info("seeded %d skill synonyms", len(seed))
        changed = await refresh_derived(conn)
        if changed:
            log.info("recomputed derived columns for %d candidates", changed)
    finally:
        await conn.close()
    return applied


async def refresh_derived(conn: asyncpg.Connection) -> int:
    """Recompute skills and location columns from each stored profile, so seed or rule changes reach candidates
    ingested earlier. Only rows whose values change are written."""
    rows = await conn.fetch("SELECT alias, canonical FROM skill_synonyms")
    normalizer = SkillNormalizer({r["alias"]: r["canonical"] for r in rows})
    updates = []
    for r in await conn.fetch(
        "SELECT id, profile, skills, location_key, willing_to_relocate, preferred_location_keys, country_keys"
        " FROM candidates"
    ):
        d = derive(CandidateProfile.model_validate_json(r["profile"]), normalizer)
        new = (d.skills, d.location_key, d.willing_to_relocate, d.preferred_location_keys, d.country_keys)
        old = (list(r["skills"]), r["location_key"], r["willing_to_relocate"], list(r["preferred_location_keys"]),
               list(r["country_keys"]))
        if new != old:
            updates.append((r["id"], *new))
    async with conn.transaction():
        if updates:
            await conn.executemany(
                "UPDATE candidates SET skills = $2, location_key = $3, willing_to_relocate = $4,"
                " preferred_location_keys = $5, country_keys = $6 WHERE id = $1",
                updates,
            )
        await save_learned(conn, normalizer)
    return len(updates)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    applied = asyncio.run(migrate())
    print(f"applied {len(applied)} migration(s): {', '.join(applied) or 'none'}")
