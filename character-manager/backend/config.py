from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = (
        "postgresql://postgres:YRQ21163x%21ecjoy"
        "@db.agnithttoxexijxkksbv.supabase.co:5432/postgres"
    )
    vfe_url: str = "http://localhost:8899"
    pool_min: int = 2
    pool_max: int = 10
    cors_origins: list[str] = ["http://localhost:8888", "http://localhost:3000"]

    class Config:
        env_file = ".env"


settings = Settings()
