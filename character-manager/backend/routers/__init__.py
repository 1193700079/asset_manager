from .characters import router as characters_router
from .media import router as media_router
from .reference import router as reference_router
from .asset_library import router as asset_library_router
from .generation import router as generation_router
from .scripts import router as scripts_router
from .comfyui_single import router as comfyui_single_router
from .avatar import router as avatar_router
from .batch_generate import router as batch_generate_router
from .audio import router as audio_router

__all__ = [
    "characters_router", "media_router", "reference_router",
    "asset_library_router", "generation_router", "scripts_router",
    "comfyui_single_router", "avatar_router", "batch_generate_router",
    "audio_router",
]
