"""A wallet's history from the network's Blockscout API (/api/v2), every page up to a cap."""

import httpx

from .errors import ToolFailure


class Explorer:
    def __init__(self, api: str, client: httpx.AsyncClient, max_pages: int) -> None:
        self.api = api.rstrip("/")
        self.client = client
        self.max_pages = max_pages

    async def get(self, path: str, params: dict | None = None):
        try:
            res = await self.client.get(f"{self.api}{path}", params=params)
            res.raise_for_status()
            return res.json()
        except (httpx.HTTPError, ValueError) as e:
            raise ToolFailure("explorer_unavailable", f"explorer {path} failed: {type(e).__name__}") from e

    async def pages(self, path: str, params: dict | None = None) -> tuple[list[dict], bool]:
        """Every item, newest first, and whether that is all of them (False when the page cap cut it short)."""
        items, query = [], dict(params or {})
        for _ in range(self.max_pages):
            body = await self.get(path, query)
            items.extend(body.get("items", []))
            following = body.get("next_page_params")
            if not following:
                return items, True
            query = {**(params or {}), **following}
        return items, False

    async def transactions(self, wallet: str) -> tuple[list[dict], bool]:
        return await self.pages(f"/addresses/{wallet}/transactions")

    async def token_transfers(self, wallet: str) -> tuple[list[dict], bool]:
        return await self.pages(f"/addresses/{wallet}/token-transfers", {"type": "ERC-20"})

    async def internal_transactions(self, wallet: str) -> tuple[list[dict], bool]:
        return await self.pages(f"/addresses/{wallet}/internal-transactions")

    async def token_balances(self, wallet: str) -> list[dict]:
        return await self.get(f"/addresses/{wallet}/token-balances")
