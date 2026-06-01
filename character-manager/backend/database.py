import psycopg2.pool
from config import settings

_pool: psycopg2.pool.ThreadedConnectionPool | None = None


def init_pool():
    global _pool
    _pool = psycopg2.pool.ThreadedConnectionPool(
        settings.pool_min, settings.pool_max, settings.database_url
    )


def get_conn():
    return _pool.getconn()


def put_conn(conn):
    _pool.putconn(conn)


def close_pool():
    global _pool
    if _pool:
        _pool.closeall()
        _pool = None
