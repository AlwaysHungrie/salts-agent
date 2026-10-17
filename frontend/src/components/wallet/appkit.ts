"use client";

import { createAppKit } from "@reown/appkit/react";
import { SolanaAdapter } from "@reown/appkit-adapter-solana/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import {
  type AppKitNetwork,
  arbitrum,
  base,
  baseSepolia,
  mainnet,
  optimism,
  polygon,
  solana,
} from "@reown/appkit/networks";

/** Every network the Worker can take a payment on (`PAY_NETWORKS`). */
const networks: [AppKitNetwork, ...AppKitNetwork[]] = [
  mainnet,
  base,
  arbitrum,
  optimism,
  polygon,
  solana,
  baseSepolia,
];

let adapter: WagmiAdapter | null = null;

/**
 * One modal for EVM and Solana wallets, drawn in the site's ink rather than Reown's blue,
 * made on first use with the Reown project id the Worker hands out (set from the admin
 * CLI). Browser-only, and made once: AppKit is a singleton.
 */
export function appKitFor(projectId: string): WagmiAdapter {
  if (adapter) return adapter;
  adapter = new WagmiAdapter({ projectId, networks });
  createAppKit({
    adapters: [adapter, new SolanaAdapter()],
    networks,
    projectId,
    metadata: {
      name: "Salts",
      description: "Personal, always accessible AI agents",
      url: window.location.origin,
      icons: [`${window.location.origin}/icon.svg`],
    },
    features: {
      analytics: false,
      email: false,
      socials: false,
      swaps: false,
      onramp: false,
    },
    themeMode: "light",
    themeVariables: { "--w3m-accent": "#141414" },
  });
  return adapter;
}
