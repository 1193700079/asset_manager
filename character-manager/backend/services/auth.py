"""Self-service auth for Character Manager: register / login with HMAC-signed
stateless tokens, plus an action log so we know who picked what.

Tables live in the default (ecjoy) datasource. Passwords are pbkdf2-hashed.
Token secret is stored in runtime_config.json (auth.secret)."""
import base64
import hashlib
import hmac
import secrets
import time

from database import get_conn, put_conn
from routers.config import _load, _save

PBKDF_ROUNDS = 120_000


def _secret() -> str:
    cfg = _load()
    s = (cfg.get("auth") or {}).get("secret")
    if not s:
        s = secrets.token_hex(32)
        cfg.setdefault("auth", {})["secret"] = s
        _save(cfg)
    return s


def ensure_tables() -> None:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                create table if not exists cm_users (
                    id serial primary key,
                    username text unique not null,
                    password_hash text not null,
                    created_at timestamptz default now()
                )""")
            cur.execute("""
                create table if not exists cm_action_log (
                    id bigserial primary key,
                    username text not null,
                    action text not null,
                    character_name text,
                    url text,
                    created_at timestamptz default now()
                )""")
        conn.commit()
    finally:
        put_conn(conn)


def _hash_pw(password: str, salt: str = "") -> str:
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), PBKDF_ROUNDS).hex()
    return f"{salt}${h}"


def _verify_pw(password: str, stored: str) -> bool:
    try:
        salt, h = stored.split("$", 1)
    except ValueError:
        return False
    calc = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), PBKDF_ROUNDS).hex()
    return hmac.compare_digest(calc, h)


def get_invite_code() -> str:
    return (_load().get("auth") or {}).get("invite_code") or ""


def register(username: str, password: str, invite_code: str = "") -> dict:
    username = (username or "").strip()
    if not username or not password:
        return {"ok": False, "error": "用户名/密码不能为空"}
    if len(username) > 40:
        return {"ok": False, "error": "用户名过长"}
    expected = get_invite_code()
    if expected and (invite_code or "").strip() != expected:
        return {"ok": False, "error": "邀请码不正确"}
    ensure_tables()
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("select 1 from cm_users where username=%s", (username,))
            if cur.fetchone():
                return {"ok": False, "error": "用户名已存在"}
            cur.execute("insert into cm_users(username, password_hash) values(%s,%s)",
                        (username, _hash_pw(password)))
        conn.commit()
        return {"ok": True, "username": username}
    finally:
        put_conn(conn)


def check_login(username: str, password: str) -> str | None:
    username = (username or "").strip()
    ensure_tables()
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("select password_hash from cm_users where username=%s", (username,))
            row = cur.fetchone()
    finally:
        put_conn(conn)
    if not row or not _verify_pw(password, row[0]):
        return None
    return username


def make_token(username: str, days: int = 30) -> str:
    exp = int(time.time()) + days * 86400
    payload = f"{username}.{exp}"
    sig = hmac.new(_secret().encode(), payload.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{payload}.{sig}".encode()).decode()


def verify_token(token: str) -> str | None:
    try:
        raw = base64.urlsafe_b64decode(token.encode()).decode()
        username, exp, sig = raw.rsplit(".", 2)
        good = hmac.new(_secret().encode(), f"{username}.{exp}".encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(good, sig):
            return None
        if int(exp) < time.time():
            return None
        return username
    except Exception:
        return None


def user_from_request(request) -> str | None:
    """Extract the logged-in username from the Authorization: Bearer <token> header."""
    hdr = request.headers.get("authorization", "")
    if hdr.lower().startswith("bearer "):
        return verify_token(hdr[7:].strip())
    return None


def log_action(username: str | None, action: str, character_name: str = None, url: str = None) -> None:
    if not username:
        return
    try:
        conn = get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "insert into cm_action_log(username, action, character_name, url) values(%s,%s,%s,%s)",
                    (username, action, character_name, url))
            conn.commit()
        finally:
            put_conn(conn)
    except Exception:
        pass  # 记录失败不该阻断主操作
