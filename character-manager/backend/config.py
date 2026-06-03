from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = (
        "postgresql://postgres:YRQ21163x%21ecjoy"
        "@db.agnithttoxexijxkksbv.supabase.co:5432/postgres"
    )
    ecjoy_database_url: str = (
        "postgresql://postgres:YRQ21163x%21ecjoy"
        "@db.agnithttoxexijxkksbv.supabase.co:5432/postgres"
    )
    priya_database_url: str = ""
    default_data_source: str = "ecjoy"
    vfe_url: str = "http://localhost:8899"
    pool_min: int = 2
    pool_max: int = 10
    cors_origins: list[str] = ["http://localhost:8888", "http://localhost:3000"]
    smartstudio_api_key: str = ""
    smartstudio_base_url: str = "https://smartstudio-intl.aliyuncs.com"

    class Config:
        env_file = ".env"

    @property
    def datasources(self) -> dict[str, str]:
        ds = {"ecjoy": self.ecjoy_database_url}
        if self.priya_database_url:
            ds["priya"] = self.priya_database_url
        return ds


settings = Settings()
