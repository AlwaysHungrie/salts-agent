import { mcpServerReady, withMcpAuth } from "../capabilities";
import type { McpServerRow } from "../mcp";
import type { Config } from "../registry";
import { Telegram } from "../telegram";
import { subscribeApp } from "../whatsapp";
import { errorMessage } from "./http";
import type { Registry } from "./stores";

/**
 * The webhook's shared secret. Telegram echoes it on every call, and it is derived
 * from the bot token so there is nothing extra for anyone to store or paste.
 */
export async function webhookSecret(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/**
 * Ask OpenRouter whether a key works.
 *
 * Worth a round trip because the failure mode moved: a key used to be the operator's
 * Worker secret, and is now something a user pastes into a form. Without this the
 * first sign of a typo is a chat that answers nothing, with the 401 buried inside a
 * stream error. Best effort, like the webhook check — the save already happened.
 */
export async function checkOpenrouterKey(
  key: string
): Promise<{ ok: boolean; error?: string; label?: string }> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Key was rejected by OpenRouter" };
    }
    if (!res.ok) return { ok: false, error: `OpenRouter answered ${res.status}.` };
    const json = (await res.json()) as { data?: { label?: string } };
    return { ok: true, label: json.data?.label ?? "" };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Point the bot at this Worker, or unhook it when the capability is switched off.
 * Best effort: a bad token is reported back to the settings page, not thrown, because
 * the rest of the save has already happened.
 */
export async function syncWebhook(
  config: Config,
  origin: string,
  agentId: string,
  api?: string
): Promise<{ ok: boolean; error?: string } | undefined> {
  if (!config.telegram_bot_token) return undefined;
  const bot = new Telegram(config.telegram_bot_token, api);
  try {
    if (config.cap_telegram) {
      // One route per agent: the update has to reach the right bot's settings, and
      // the token it is checked against is the one on that agent's row.
      await bot.setWebhook(
        `${origin}/telegram/webhook/${agentId}`,
        await webhookSecret(config.telegram_bot_token)
      );
    } else {
      await bot.deleteWebhook();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Subscribe this agent's Meta app to its WhatsApp Business Account, so deliveries
 * reach the callback URL at all.
 *
 * Meta has no API for setting the callback URL — that is pasted in by hand — but the
 * account-level subscription behind it does have one, and it is the step that costs
 * people an evening: everything looks configured and no webhook ever arrives. So it
 * happens on every save, like Telegram's `setWebhook`, rather than in a curl the
 * setup guide has to teach.
 *
 * Best effort, and reported rather than thrown: the settings are already saved.
 */
export async function syncWhatsappSubscription(
  config: Config,
  api?: string
): Promise<{ ok: boolean; error?: string } | undefined> {
  if (!config.cap_whatsapp) return undefined;
  if (!config.whatsapp_waba_id || !config.whatsapp_access_token) return undefined;
  try {
    await subscribeApp(config.whatsapp_access_token, config.whatsapp_waba_id, api);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Ask a server what it can do, and cache the answer on its row.
 *
 * This is what turns a URL into usable tools, so it runs on save, after an OAuth
 * connection, and whenever the user asks for a refresh. A failure is recorded rather
 * than thrown: the card shows why, and the server stays editable.
 */
export async function syncMcpTools(reg: Registry, row: McpServerRow): Promise<McpServerRow> {
  if (!mcpServerReady(row)) {
    return (await reg.updateMcpServer(row.id, { tools_json: "", last_error: "" })) ?? row;
  }
  try {
    const tools = await withMcpAuth(row, reg, (client) => client.listTools());
    return (
      (await reg.updateMcpServer(row.id, {
        tools_json: JSON.stringify(tools),
        tools_synced_at: Date.now(),
        last_error: "",
      })) ?? row
    );
  } catch (err) {
    const message = errorMessage(err);
    return (await reg.updateMcpServer(row.id, { last_error: message })) ?? row;
  }
}
