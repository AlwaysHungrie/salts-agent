from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    hsk_network: Literal["testnet", "mainnet"] = "testnet"
    # Override the network's public RPC or Blockscout API (…/api/v2).
    rpc_url: str | None = None
    explorer_api: str | None = None

    mcp_transport: Literal["stdio", "http"] = "stdio"
    mcp_host: str = "127.0.0.1"
    mcp_port: int = 8390
    mcp_auth_token: str | None = None

    # History pages (50 items each) read per list for P&L; past this the result says it is incomplete.
    max_history_pages: int = 40
    http_timeout_seconds: float = 20.0


@lru_cache
def get_settings() -> Settings:
    return Settings()
