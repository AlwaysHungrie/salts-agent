"""HSKswap (a Uniswap V3 fork) on HSK Chain. Addresses from HSKswap's developer docs, checked on chain."""

from dataclasses import dataclass, field

MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
FEE_TIERS = (100, 500, 3000, 10000)


@dataclass(frozen=True)
class Network:
    name: str
    chain_id: int
    rpc: str
    explorer: str  # Blockscout, also its API at explorer + /api/v2
    factory: str
    position_manager: str
    whsk: str
    router: str
    quoter: str
    # HskVaultFactory from contracts/, one trading vault per owner. None: no vaults on this network yet.
    vault_factory: str | None
    # Valued at $1. Lowercase address -> symbol.
    stables: dict[str, str] = field(default_factory=dict)

    @property
    def explorer_api(self) -> str:
        return f"{self.explorer}/api/v2"


NETWORKS = {
    "testnet": Network(
        name="HSK Chain Testnet",
        chain_id=133,
        rpc="https://testnet.hsk.xyz",
        explorer="https://testnet-explorer.hskchain.net",
        factory="0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0",
        position_manager="0x73dEc6bfa6751509b08480bd97f54b874E3b20e8",
        whsk="0xCA8aAceEC5Db1e91B9Ed3a344bA026c4a2B3ebF6",
        router="0xa6914E66690c6794244B5f66a09eAEbf66254237",
        quoter="0x73820d9eE5Bf1BfcD429580320FC7A374E8fa1cC",
        vault_factory="0xb1fe58b7f75Df824e18A4D176FF1365A54e0e151",
        stables={
            "0x98b6173a8b7dfc52ce8bc88f1184a918a1ccaa4f": "USDT",
            "0x93f960a8dab5a541e93e6ddacd54f49a1750de81": "USDC",
        },
    ),
    "mainnet": Network(
        name="HSK Chain",
        chain_id=177,
        rpc="https://mainnet.hsk.xyz",
        explorer="https://hsk.blockscout.com",
        factory="0x972cA9D1662F5e029cD18327D29026532E84c742",
        position_manager="0xDF0A9b833Db0E4CeEa103A4408f3B68e7FC0cad5",
        whsk="0xB210D2120d57b758EE163cFfb43e73728c471Cf1",
        router="0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3",
        quoter="0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD",
        vault_factory=None,
        stables={
            "0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029": "USDT",
            "0x054ed45810dbbab8b27668922d110669c9d88d0a": "USDC.e",
        },
    ),
}
