"""Auth endpoints: self-service register / login / me."""
from fastapi import APIRouter, Request
from pydantic import BaseModel

from services import auth

router = APIRouter(prefix="/api/auth", tags=["auth"])


class Creds(BaseModel):
    username: str
    password: str
    invite_code: str = ""


@router.post("/register")
async def register(data: Creds):
    r = auth.register(data.username, data.password, data.invite_code)
    if not r.get("ok"):
        return {"status": "error", "message": r.get("error", "注册失败")}
    token = auth.make_token(r["username"])
    return {"status": "ok", "username": r["username"], "token": token}


@router.post("/login")
async def login(data: Creds):
    username = auth.check_login(data.username, data.password)
    if not username:
        return {"status": "error", "message": "用户名或密码错误"}
    return {"status": "ok", "username": username, "token": auth.make_token(username)}


@router.get("/me")
async def me(request: Request):
    username = auth.user_from_request(request)
    if not username:
        return {"status": "error", "message": "未登录"}
    return {"status": "ok", "username": username}
