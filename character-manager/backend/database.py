import contextvars

import psycopg2.pool
from config import settings

_pools: dict[str, psycopg2.pool.ThreadedConnectionPool] = {}
_current_ds: contextvars.ContextVar[str] = contextvars.ContextVar(
    "data_source", default=settings.default_data_source
)


def init_pool():
    for name, url in settings.datasources.items():
        try:
            _pools[name] = psycopg2.pool.ThreadedConnectionPool(
                settings.pool_min, settings.pool_max, url
            )
        except Exception as e:
            print(f"[database] failed to init pool for '{name}': {e}")


def set_data_source(name: str):
    _current_ds.set(name)


def get_data_source() -> str:
    return _current_ds.get()


def _resolve_pool() -> psycopg2.pool.ThreadedConnectionPool:
    name = get_data_source()
    pool = _pools.get(name) or _pools.get(settings.default_data_source)
    if pool is None:
        raise RuntimeError(f"No connection pool available for data source '{name}'")
    return pool


def get_conn():
    return _resolve_pool().getconn()


def put_conn(conn):
    _resolve_pool().putconn(conn)


def close_pool():
    global _pools
    for pool in _pools.values():
        pool.closeall()
    _pools = {}
