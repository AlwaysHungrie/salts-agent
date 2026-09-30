import asyncpg
from pgvector.asyncpg import register_vector

from .config import get_settings


async def _init_conn(conn: asyncpg.Connection) -> None:
    await register_vector(conn)


async def create_pool(database_url: str | None = None) -> asyncpg.Pool:
    return await asyncpg.create_pool(
        database_url or get_settings().database_url, min_size=1, max_size=10, init=_init_conn
    )
