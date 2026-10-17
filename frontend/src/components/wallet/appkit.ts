"use client";

import { createAppKit } from "@reown/appkit/react";
import { SolanaAdapter } from "@reown/appkit-adapter-solana/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import {
  type AppKitNetwork,
  arbitrum,
  base,
  mainnet,
  optimism,
  polygon,
  solana,
} from "@reown/appkit/networks";

/** Reown's project id, from its dashboard. Unset, wallet payments are not offered. */
export const REOWN_PROJECT_ID = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "";

/** Every network the Worker can take a payment on (`PAY_NETWORKS`). */
const networks: [AppKitNetwork, ...AppKitNetwork[]] = [
  mainnet,
  base,
  arbitrum,
  optimism,
  polygon,
  solana,
];

export const wagmiAdapter = new WagmiAdapter({ projectId: REOWN_PROJECT_ID, networks });

// One modal for EVM and Solana wallets, drawn in the site's ink rather than Reown's blue.
// Imported only in the browser, and only once a project id is set.
createAppKit({
  adapters: [wagmiAdapter, new SolanaAdapter()],
  networks,
  projectId: REOWN_PROJECT_ID,
  metadata: {
    name: "Salts",
    description: "Personal, always accessible AI agents",
    url: window.location.origin,
    icons: [`${window.location.origin}/icon.svg`],
  },
  features: { analytics: false, email: false, socials: false, swaps: false, onramp: false },
  themeMode: "light",
  themeVariables: { "--w3m-accent": "#141414" },
});
