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
                settings.pool_min, settings.pool_max, url,
                application_name="character-manager",
                options="-c timezone=UTC",
            )
        except Exception as e:
            print(f"[database] failed to init pool for '{name}': {e}")


def set_data_source(name: str):
    _current_ds.set(name)


def get_data_source() -> str:
    return _current_ds.get()


def _merged_members(name: str) -> list[str]:
    return getattr(settings, "merged_members", {}).get(name, [name])


def _resolve_pool() -> psycopg2.pool.ThreadedConnectionPool:
    name = get_data_source()
    # For single-connection ops on a merged source, use the primary member pool.
    members = _merged_members(name)
    if members:
        name = members[0]
    pool = _pools.get(name) or _pools.get(settings.default_data_source)
    if pool is None:
        raise RuntimeError(f"No connection pool available for data source '{name}'")
    return pool


def fetch_merged(query, params=None):
    """Run a read query across every pool backing the active source and return
    the concatenated RealDictCursor rows. For a non-merged source this is just
    the single pool; for the merged 'ecjoy' source it unions ecjoy + ecjoy-tiktok."""
    import psycopg2.extras
    rows = []
    for m in _merged_members(get_data_source()):
        pool = _pools.get(m)
        if pool is None:
            continue
        conn = _getconn_alive(pool)
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(query, params or ())
                rows.extend(cur.fetchall())
        finally:
            pool.putconn(conn)
    return rows


def _is_alive(conn) -> bool:
    """Cheaply verify a pooled connection is still usable. Supabase (and the
    cross-region pooler) closes idle connections server-side; a stale socket
    surfaces as 'server closed the connection unexpectedly' on the next query.
    Testing on checkout lets us discard dead connections instead of handing
    them to a request."""
    if conn.closed:
        return False
    try:
        # Reset any aborted-transaction state left by a prior failed query.
        conn.rollback()
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
        return True
    except Exception:
        return False


def _getconn_alive(pool):
    """Pull a live connection from the pool, discarding (and replacing) any
    stale ones. Falls back to a raw getconn after a few attempts."""
    for _ in range(3):
        conn = pool.getconn()
        if _is_alive(conn):
            return conn
        try:
            pool.putconn(conn, close=True)
        except Exception:
            pass
    return pool.getconn()


def get_conn():
    return _getconn_alive(_resolve_pool())


def conn_for(name=None, cid=None):
    """(pool_name, conn) for the merged-member pool that holds the character.
    Lets per-character writes hit the right DB (e.g. ecjoy-tiktok) under a merged
    source instead of always the primary pool. Falls back to the primary member."""
    members = _merged_members(get_data_source())
    where, val = ("name = %s", name) if name is not None else ("id = %s", cid)
    for m in members:
        pool = _pools.get(m)
        if pool is None:
            continue
        conn = _getconn_alive(pool)
        try:
            with conn.cursor() as cur:
                cur.execute(f"SELECT 1 FROM characters WHERE {where} LIMIT 1", (val,))
                if cur.fetchone():
                    return m, conn
        except Exception:
            pass
        pool.putconn(conn)
    pname = members[0]
    return pname, _getconn_alive(_pools[pname])


def put_conn_named(pool_name, conn):
    p = _pools.get(pool_name)
    if p is not None:
        p.putconn(conn)


def put_conn(conn):
    _resolve_pool().putconn(conn)


def get_conn_for(name: str):
    """Get a connection from a specific data source's pool (bypasses contextvar)."""
    pool = _pools.get(name) or _pools.get(settings.default_data_source)
    if pool is None:
        raise RuntimeError(f"No connection pool available for data source '{name}'")
    return _getconn_alive(pool)


def put_conn_for(name: str, conn):
    """Return a connection to a specific data source's pool (bypasses contextvar)."""
    pool = _pools.get(name) or _pools.get(settings.default_data_source)
    if pool is not None:
        pool.putconn(conn)


def close_pool():
    global _pools
    for pool in _pools.values():
        pool.closeall()
    _pools = {}
