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
   * The impersonation back door, and nothing else.
   *
   * Present it as `x-api-secret` and the Worker takes the `x-user-email` beside it at
   * face value: any address, no sign-in, no proof, treated as that person for the
   * whole request. It is not an origin check and not a gate — the gate is a verified
   * Clerk token — so this is best understood as a master key to every identity in the
   * deployment rather than as a password for the API.
   *
   * Optional. Unset means the back door does not exist, which is the safe direction:
   * a deployment that forgets it loses impersonation, not its access control.
   */
  API_SECRET?: string;
  /**
   * The Clerk instance whose session tokens this Worker will verify, as the exact
   * `iss` those tokens carry: `https://<subdomain>.clerk.accounts.dev` on a
   * development instance, `https://clerk.<your-domain>` on a production one.
   *
   * Set it and a call arriving with a valid `Authorization: Bearer <session token>`
   * is identified by that token's own claims — a signature this Worker checks against
   * Clerk's published keys, which is the only identity here that cannot be asserted
   * by whoever holds `API_SECRET`. Unset, there is nothing to verify against and
   * every call falls back to the `x-user-email` header.
   */
  CLERK_ISSUER?: string;
  /** Telegram's API host. Only set to stand a local Bot API server in its place. */
  TELEGRAM_API_BASE?: string;

  /** Graph's host. Only set to point the channel at a stand-in. */
  WHATSAPP_API_BASE?: string;
};
