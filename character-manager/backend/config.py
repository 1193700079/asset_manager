from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    priya_database_url: str = ""
    default_data_source: str = "priya"
    vfe_url: str = "http://localhost:8899"
    # qwen-edit image edit API on the A100 (systemd qwen-edit-tunnel:
    # 127.0.0.1:18020 -> A100 127.0.0.1:8020 via the reverse tunnel on :52222).
    qwen_edit_url: str = "http://127.0.0.1:18020"
    # vps141 ComfyUI async API — public host reachable from ecs50 directly.
    vps141_url: str = "http://45.207.197.141:8020"
    comfy_api_key: str = "sk-ecjoy-comfyui-2026a1b2c3"
    pool_min: int = 2
    pool_max: int = 10
    cors_origins: list[str] = ["http://localhost:8888", "http://localhost:3000"]
    smartstudio_api_key: str = ""
    smartstudio_base_url: str = "https://smartstudio-intl.aliyuncs.com"
    dashscope_api_key: str = ""
    supabase_url: str = ""
    supabase_service_role_key: str = ""

    oss_access_key_id: str = ""
    oss_access_key_secret: str = ""
    oss_endpoint: str = "https://oss-ap-northeast-2.aliyuncs.com"
    oss_bucket: str = "priya"
    oss_prefix: str = "candy_ai/comfyui_output/"

    class Config:
        env_file = ".env"

    @property
    def datasources(self) -> dict[str, str]:
        # saved_frames 已迁到 priya 库; cm 只连 priya, 彻底脱离 ecjoy。
        ds = {}
        if self.priya_database_url:
            ds["priya"] = self.priya_database_url
        return ds

    @property
    def merged_members(self) -> dict[str, str]:
        # 不再有合并数据源。
        return {}

    @property
    def public_datasources(self) -> list[str]:
        return list(self.datasources)


settings = Settings()
