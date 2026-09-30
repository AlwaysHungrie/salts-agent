"""Apply migrations/*.sql in filename order. `{EMBED_DIM}` is substituted from config."""

import asyncio
import logging
from pathlib import Path

import asyncpg

from .config import get_settings
from .skills import load_seed

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
            "INSERT INTO skill_synonyms (alias, canonical) VALUES ($1, $2)"
            " ON CONFLICT (alias) DO UPDATE SET canonical = EXCLUDED.canonical",
            list(seed.items()),
        )
        log.info("seeded %d skill synonyms", len(seed))
    finally:
        await conn.close()
    return applied


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    applied = asyncio.run(migrate())
    print(f"applied {len(applied)} migration(s): {', '.join(applied) or 'none'}")
