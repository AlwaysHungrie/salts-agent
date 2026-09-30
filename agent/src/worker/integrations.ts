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
 * Check an OpenRouter key when it is pasted, so a typo shows now rather than as a silent
 * chat. Best effort: the save has already happened.
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
 * Point the bot at this Worker, or unhook it when Telegram is off. Errors are reported,
 * not thrown; the save has already happened.
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
 * Subscribe the agent's Meta app to its Business Account on every save (the callback URL
 * is pasted by hand; this half is the step people miss). Reported, not thrown.
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

/** List a server's tools and cache them on its row. Failures are recorded on the card. */
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
