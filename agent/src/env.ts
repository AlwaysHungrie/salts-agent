import { SessionAgent } from "./agent";
import { AgentDirectory, SessionRegistry } from "./registry";

export type Env = {
  SessionAgent: DurableObjectNamespace<SessionAgent>;
  SessionRegistry: DurableObjectNamespace<SessionRegistry>;
  /** The index of which agents exist; a DO namespace cannot be enumerated. */
  AgentDirectory: DurableObjectNamespace<AgentDirectory>;
  /** Object storage the workspace spills large files into: images, PDFs, clips. */
  FILES: R2Bucket;
  /**
   * The owner's key to the admin routes, sent as `x-api-secret`. It names nobody: acting
   * as a user always takes that user's Clerk token. Optional; unset disables the admin routes.
   */
  API_SECRET?: string;
  /**
   * The exact `iss` of the Clerk tokens this Worker verifies (e.g.
   * `https://<subdomain>.clerk.accounts.dev`). The only source of identity.
   */
  CLERK_ISSUER?: string;
  /**
   * The web app's origin (e.g. `https://salts-agent-app.vercel.app`), for the links
   * `!docs`, `!settings` and `!mcp` send. Unset, they say there is none.
   */
  APP_URL?: string;
  /** Telegram's API host. Only set to stand a local Bot API server in its place. */
  TELEGRAM_API_BASE?: string;

  /** Graph's host. Only set to point the channel at a stand-in. */
  WHATSAPP_API_BASE?: string;

  /**
   * Where wallet purchases are paid to: one EVM address for every EVM network, one Solana
   * address. A blank one switches that family's networks off.
   */
  PAYMENT_ADDRESSES?: { evm?: string; solana?: string };
  /** A JSON-RPC endpoint per payment network id (see `PAY_NETWORKS`); missing = off. */
  PAYMENT_RPC?: Record<string, string>;
};
