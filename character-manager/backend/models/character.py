from pydantic import BaseModel
from typing import Any


class CharacterBase(BaseModel):
    name: str
    category: str = "uncategorized"
    description: str = ""
    attributes: dict[str, Any] = {}
    media: list[dict[str, Any]] = []


class CharacterOut(BaseModel):
    id: int
    name: str | None
    category: str | None
    description: str | None
    attributes: dict[str, Any] | None
    media: list[dict[str, Any]] | None
    content_rating: str | None
    sort_priority: int | None


class CharacterListItem(BaseModel):
    id: int
    name: str | None
    category: str | None


class CategoryCount(BaseModel):
    category: str | None
    count: int
