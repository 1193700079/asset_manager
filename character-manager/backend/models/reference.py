from pydantic import BaseModel
from typing import Any


class RefImageCreate(BaseModel):
    character_id: int
    image_url: str
    prompt: str = ""
    dimensions: dict[str, Any] = {}
    tags: list[str] = []
    style: str = ""
    description: str = ""
    vfe_frame_id: int | None = None


class RefImageOut(BaseModel):
    id: int
    character_id: int
    vfe_frame_id: int | None
    image_url: str
    prompt: str | None
    dimensions: dict[str, Any] | None
    tags: list[str] | None
    style: str | None
    description: str | None
    created_at: str | None


class RefImageDelete(BaseModel):
    id: int
