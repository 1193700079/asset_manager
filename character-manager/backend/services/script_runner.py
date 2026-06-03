"""Custom batch script runner — manages local ComfyUI batch scripts as subprocesses."""
import os
import signal
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from dataclasses import dataclass, field, asdict

SCRIPTS_DIR = Path("/mnt/cypher/project/asset_manager/scripts")
LOGS_DIR = Path("/mnt/cypher/project/asset_manager/character-manager/backend/logs/batch")
LOGS_DIR.mkdir(parents=True, exist_ok=True)

_lock = threading.Lock()
_jobs: dict[str, dict] = {}  # job_id -> job info
_counter = 0


def _next_id() -> str:
    global _counter
    with _lock:
        _counter += 1
        return f"job-{_counter:04d}-{int(time.time())}"


@dataclass
class ScriptDef:
    key: str
    label: str
    script_file: str
    category: str  # "image" or "video"
    description: str
    needs_args: bool = False
    default_args: dict = field(default_factory=dict)

    def get_command(self, extra_args: dict = None) -> list[str]:
        """Build the command line for this script."""
        args = extra_args or {}
        cmd = ["/mnt/cypher/miniconda3/bin/python", str(SCRIPTS_DIR / self.script_file)]

        for k, v in {**self.default_args, **args}.items():
            if v is None or v == "":
                continue
            if k.startswith("_"):
                # Positional args (no flag)
                cmd.append(str(v))
            else:
                cmd.extend([f"--{k}", str(v)])

        return cmd


# ── Script definitions ──────────────────────────────
SCRIPTS: dict[str, ScriptDef] = {
    "batch_swap": ScriptDef(
        key="batch_swap",
        label="批量换脸 (FaceSwap)",
        script_file="batch_swap_v2.py",
        category="image",
        description="20脸×N身体 ComfyUI批量换脸，每张身体用一次",
    ),
    "batch_zimage": ScriptDef(
        key="batch_zimage",
        label="批量文生图 (ZImage)",
        script_file="batch_z-image_generate.py",
        category="image",
        description="ZImage ComfyUI 批量文生图，8端口并行",
        needs_args=True,
        default_args={
            "_start": "0",
            "_end": "50",
        },
    ),
    "batch_edit": ScriptDef(
        key="batch_edit",
        label="批量图片编辑 (ImageEdit)",
        script_file="batch-edit.py",
        category="image",
        description="角色图片批量编辑，每角色多条生成",
        needs_args=True,
        default_args={
            "prompts-per-image": "10",
            "ports": "8188,8189,8190,8191,8192,8193,8194,8195",
        },
    ),
    "batch_video": ScriptDef(
        key="batch_video",
        label="批量视频 (LTX Video)",
        script_file="batch-video.py",
        category="video",
        description="LTX Video 工作流批量视频生成",
        needs_args=True,
        default_args={
            "ports": "8188,8189,8190,8191",
        },
    ),
}


def list_scripts() -> list[dict]:
    """List available scripts with their definitions."""
    return [
        {"key": s.key, "label": s.label, "category": s.category,
         "description": s.description, "needs_args": s.needs_args,
         "default_args": {k: v for k, v in s.default_args.items() if not k.startswith("_")},
         "positional_args": [k[1:] for k in s.default_args.keys() if k.startswith("_")]}
        for s in SCRIPTS.values()
    ]


def launch_script(script_key: str, extra_args: dict = None, character_name: str = "") -> dict:
    """Launch a batch script as a background subprocess."""
    if script_key not in SCRIPTS:
        return {"status": "error", "message": f"Unknown script: {script_key}"}

    script_def = SCRIPTS[script_key]
    job_id = _next_id()

    cmd = script_def.get_command(extra_args)
    log_path = LOGS_DIR / f"{job_id}.log"

    try:
        # Check if script file exists
        if not (SCRIPTS_DIR / script_def.script_file).exists():
            return {"status": "error", "message": f"Script not found: {script_def.script_file}"}

        with open(log_path, "w", encoding="utf-8") as log_f:
            proc = subprocess.Popen(
                cmd,
                stdout=log_f,
                stderr=subprocess.STDOUT,
                cwd=str(SCRIPTS_DIR),
                preexec_fn=os.setsid,  # New process group for clean kill
            )

        job = {
            "job_id": job_id,
            "script_key": script_key,
            "script_file": script_def.script_file,
            "label": script_def.label,
            "character_name": character_name,
            "pid": proc.pid,
            "status": "running",
            "command": " ".join(cmd),
            "log_path": str(log_path),
            "started_at": datetime.now().isoformat(),
            "completed_at": None,
            "exit_code": None,
            "_proc": proc,
        }

        with _lock:
            _jobs[job_id] = job

        # Start monitoring thread
        threading.Thread(target=_monitor_job, args=(job_id,), daemon=True).start()

        return {
            "status": "ok",
            "job_id": job_id,
            "pid": proc.pid,
            "command": " ".join(cmd),
        }

    except Exception as e:
        return {"status": "error", "message": str(e)}


def _monitor_job(job_id: str):
    """Background thread that monitors a subprocess job."""
    while True:
        with _lock:
            job = _jobs.get(job_id)
        if not job:
            return

        proc = job.get("_proc")
        if not proc:
            return

        ret = proc.poll()
        if ret is not None:
            # Process finished
            with _lock:
                _jobs[job_id]["status"] = "completed" if ret == 0 else "failed"
                _jobs[job_id]["exit_code"] = ret
                _jobs[job_id]["completed_at"] = datetime.now().isoformat()
            return

        time.sleep(3)


def kill_job(job_id: str) -> dict:
    """Kill a running job."""
    with _lock:
        job = _jobs.get(job_id)
    if not job:
        return {"status": "error", "message": "Job not found"}

    if job["status"] != "running":
        return {"status": "error", "message": f"Job already {job['status']}"}

    proc = job.get("_proc")
    if proc:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            time.sleep(1)
            if proc.poll() is None:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass

    with _lock:
        _jobs[job_id]["status"] = "killed"
        _jobs[job_id]["completed_at"] = datetime.now().isoformat()

    return {"status": "ok", "message": f"Job {job_id} killed"}


def get_job_status(job_id: str) -> dict:
    """Get status of a specific job."""
    with _lock:
        job = _jobs.get(job_id)
    if not job:
        return {"status": "error", "message": "Job not found"}

    # Read last N lines of log
    log_lines = ""
    log_path = job.get("log_path")
    if log_path and Path(log_path).exists():
        try:
            with open(log_path, "r", encoding="utf-8") as f:
                lines = f.readlines()
                log_lines = "".join(lines[-20:])
        except Exception:
            pass

    return {
        "job_id": job_id,
        "script_key": job["script_key"],
        "label": job["label"],
        "character_name": job["character_name"],
        "pid": job["pid"],
        "status": job["status"],
        "exit_code": job.get("exit_code"),
        "command": job["command"],
        "started_at": job["started_at"],
        "completed_at": job.get("completed_at"),
        "log_tail": log_lines,
    }


def list_jobs(character_name: str = None) -> list[dict]:
    """List all jobs, optionally filtered by character."""
    with _lock:
        jobs = list(_jobs.values())

    if character_name:
        jobs = [j for j in jobs if j["character_name"] == character_name]

    results = []
    for job in sorted(jobs, key=lambda x: x["started_at"], reverse=True)[:20]:
        log_tail = ""
        log_path = job.get("log_path")
        if log_path and Path(log_path).exists():
            try:
                with open(log_path, "r", encoding="utf-8") as f:
                    lines = f.readlines()
                    log_tail = "".join(lines[-5:])
            except Exception:
                pass

        results.append({
            "job_id": job["job_id"],
            "script_key": job["script_key"],
            "label": job["label"],
            "character_name": job["character_name"],
            "pid": job["pid"],
            "status": job["status"],
            "exit_code": job.get("exit_code"),
            "started_at": job["started_at"],
            "completed_at": job.get("completed_at"),
            "log_tail": log_tail,
        })

    return results
