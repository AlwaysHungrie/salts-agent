import { base, baseSepolia } from "viem/chains";

/** `CHAIN=base-sepolia` pays test USDC; anything else (default) pays real USDC on Base. */
const testnet = process.env.CHAIN === "base-sepolia";

export const chain = testnet ? baseSepolia : base;

/** What the agent's wallet is set to: public RPC (the agent's owner can see it), and USDC. */
export const WALLET_NETWORK = testnet
  ? {
      family: "evm",
      name: "Base Sepolia",
      rpc_url: "https://sepolia.base.org",
      explorer_url: "https://sepolia.basescan.org",
      native_symbol: "ETH",
      tokens: [{ symbol: "USDC", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 }],
    }
  : {
      family: "evm",
      name: "Base",
      rpc_url: "https://mainnet.base.org",
      explorer_url: "https://basescan.org",
      native_symbol: "ETH",
      tokens: [{ symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }],
    };
