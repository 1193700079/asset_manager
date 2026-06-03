"""Router for custom batch ComfyUI scripts."""
from fastapi import APIRouter
from pydantic import BaseModel
from services import script_runner

router = APIRouter(prefix="/api/scripts", tags=["scripts"])


class LaunchRequest(BaseModel):
    script_key: str
    character_name: str = ""
    args: dict = {}


class KillRequest(BaseModel):
    job_id: str


@router.get("/list")
async def list_scripts():
    """List all available batch scripts."""
    return {"scripts": script_runner.list_scripts()}


@router.post("/launch")
async def launch_script(data: LaunchRequest):
    """Launch a batch script as a background subprocess."""
    return script_runner.launch_script(
        script_key=data.script_key,
        extra_args=data.args,
        character_name=data.character_name,
    )


@router.post("/kill")
async def kill_job(data: KillRequest):
    """Kill a running script job."""
    return script_runner.kill_job(data.job_id)


@router.get("/jobs/{character_name}")
async def list_jobs(character_name: str):
    """List script jobs for a character."""
    return {"jobs": script_runner.list_jobs(character_name)}


@router.get("/jobs")
async def list_all_jobs():
    """List all script jobs."""
    return {"jobs": script_runner.list_jobs()}


@router.get("/status/{job_id}")
async def get_job_status(job_id: str):
    """Get detailed status of a script job."""
    return script_runner.get_job_status(job_id)
