from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Uploads, opened workbooks and exports live here: DATA_DIR/uploads, DATA_DIR/workbooks/<id>/.
    data_dir: Path = Path("./data")
    # Files the user drops on this machine for the agent to open by name. Default DATA_DIR/inbox.
    inbox_dir: Path | None = None

    mcp_transport: Literal["stdio", "http"] = "stdio"
    mcp_host: str = "127.0.0.1"
    mcp_port: int = 8000
    mcp_auth_token: str | None = None

    max_file_bytes: int = 25 * 1024 * 1024
    # Rows a query or a sheet read returns at most; the agent pages for more.
    max_rows: int = 200
    # run_python executes model-written code on this machine. Off unless set to true.
    allow_python: bool = False
    python_timeout_seconds: int = 60

    def inbox(self) -> Path:
        return self.inbox_dir or self.data_dir / "inbox"


@lru_cache
def get_settings() -> Settings:
    return Settings()
