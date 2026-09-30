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
  /** Telegram's API host. Only set to stand a local Bot API server in its place. */
  TELEGRAM_API_BASE?: string;

  /** Graph's host. Only set to point the channel at a stand-in. */
  WHATSAPP_API_BASE?: string;
};
