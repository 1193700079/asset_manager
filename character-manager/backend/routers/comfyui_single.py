"""Router for single ComfyUI processing tasks (extracted from batch scripts)."""
from fastapi import APIRouter
from fastapi.responses import FileResponse
from pydantic import BaseModel
from services import comfyui_single

router = APIRouter(prefix="/api/comfyui", tags=["comfyui-single"])


class SingleSubmitRequest(BaseModel):
    task_type: str           # comfy_swap | comfy_zimage | comfy_edit | comfy_video
    image_url: str = ""      # source image URL (or local path)
    face_url: str = ""       # face image URL (for swap only)
    prompt: str = ""         # text prompt (for zimage, edit, video)
    seed: int = 0            # 0 = random
    character_name: str = ""


@router.get("/scripts")
async def list_scripts():
    return {"scripts": comfyui_single.list_comfyui_scripts()}


@router.post("/submit")
async def submit_single(data: SingleSubmitRequest):
    return comfyui_single.submit_single(
        task_type=data.task_type,
        image_url=data.image_url,
        face_url=data.face_url,
        prompt=data.prompt,
        seed=data.seed,
        character_name=data.character_name,
    )


@router.get("/jobs")
async def list_all_jobs():
    return {"jobs": comfyui_single.list_single_jobs()}


@router.get("/jobs/{character_name}")
async def list_character_jobs(character_name: str):
    return {"jobs": comfyui_single.list_single_jobs(character_name)}


@router.get("/status/{job_id}")
async def get_status(job_id: str):
    job = comfyui_single.get_single_job(job_id)
    if job is None:
        return {"status": "error", "message": "Job not found"}
    return job


@router.get("/result/{job_id}/{filename}")
async def get_result(job_id: str, filename: str):
    path = comfyui_single.get_result_file(job_id, filename)
    if path is None:
        return {"status": "error", "message": "File not found"}
    return FileResponse(path)


class SaveComfyuiResultRequest(BaseModel):
    job_id: str
    character_name: str
    media_type: str = "image"


@router.post("/save")
async def save_comfyui_result(data: SaveComfyuiResultRequest):
    """Save a completed ComfyUI job result into a character's media array."""
    return comfyui_single.save_result_to_character(
        job_id=data.job_id,
        character_name=data.character_name,
        media_type=data.media_type,
    )
