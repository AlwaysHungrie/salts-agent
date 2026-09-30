import { modelCatalog } from "../models";
import { TELEGRAM_WHITELIST_DEFAULTS } from "../capabilities";
import { type Config, DEFAULT_META, type MetaSettings, type ModelChoice } from "../registry";
import { deploymentSettings } from "../settings";
import { redact, validateConfig } from "../validation/config";
import { lockedColumns, redactMeta, validateMeta } from "../validation/meta";
import { capabilitiesFor, modelOptions, notedCapabilities } from "../worker/capability-views";
import { errorMessage, json, jsonError, notFound, readJson } from "../worker/http";
import { checkOpenrouterKey, syncWebhook, syncWhatsappSubscription } from "../worker/integrations";
import { agentFor, applyMeta } from "../worker/provisioning";
import { readConfig, writeConfig } from "../worker/stores";
import type { AgentCall } from "./agent";
import { guestsView } from "./guest";

/** A model the agent's meta document does not offer, or undefined when it is allowed. */
function unofferedModel(patch: Partial<Config>, models: ModelChoice[]): Response | undefined {
  if (patch.model === undefined || !models.length) return undefined;
  if (models.some((m) => m.id === patch.model)) return undefined;
  return jsonError(`model not offered: ${patch.model}`, 400);
}

/** `/api/agents/:agentId/config`: the settings page, the users'. */
export async function handleConfig(call: AgentCall): Promise<Response | undefined> {
  if (call.request.method === "GET") return await getConfig(call);
  if (call.request.method === "PATCH") return await patchConfig(call);
  return undefined;
}

async function getConfig({ env, reg, agent, email, access }: AgentCall): Promise<Response> {
  const meta = await reg.meta();
  const settings = await deploymentSettings(env);
  return json({
    agent: agentFor(agent, email),
    config: redact(await readConfig(env, reg)),
    // Read-only here: the spend ceiling and member limit are the admin's.
    spend: await reg.spendState(),
    member_limit: meta.member_limit,
    // Filtered here so a PATCH from this page can only carry an offered model.
    models: modelOptions(meta.models, modelCatalog(settings)),
    capabilities: notedCapabilities(capabilitiesFor(meta, settings), settings),
    // What this page may not show or change; the PATCH drops these.
    locked: meta.locked,
    guests: guestsView(access),
    // Sent rather than compiled in, so the browser refuses at the Worker's numbers.
    limits: {
      max_files_per_message: settings.max_files_per_message,
      max_upload_bytes: settings.max_upload_bytes,
    },
  });
}

async function patchConfig({ request, env, url, agentId, reg }: AgentCall): Promise<Response> {
  const body = (await request.json()) as Partial<Config>;
  let patch: Partial<Config>;
  try {
    patch = validateConfig(body);
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }
  const meta = await reg.meta();
  const refused = unofferedModel(patch, meta.models);
  if (refused) return refused;
  // Locked columns are dropped rather than refused, so one stale tab does not block
  // every other setting in the same save.
  const locks = lockedColumns(meta.locked);
  for (const key of Object.keys(patch)) {
    if (locks.has(key)) delete patch[key as keyof Config];
  }
  // First enable of Telegram seeds empty whitelists with entries that match nothing,
  // so the bot does not answer everyone.
  if (patch.cap_telegram === 1) {
    const current = await readConfig(env, reg);
    if (!current.cap_telegram) {
      for (const [key, value] of Object.entries(TELEGRAM_WHITELIST_DEFAULTS)) {
        const field = key as keyof typeof TELEGRAM_WHITELIST_DEFAULTS;
        if (patch[field] === undefined && current[field].trim() === "") patch[field] = value;
      }
    }
  }
  const config = await writeConfig(env, reg, patch);
  // Saving the credentials is the whole setup for Telegram and WhatsApp.
  const telegram = await syncWebhook(config, url.origin, agentId, env.TELEGRAM_API_BASE);
  const whatsapp = await syncWhatsappSubscription(config, env.WHATSAPP_API_BASE);
  // Only a freshly pasted key is checked; the mask never reaches here.
  const openrouter = patch.openrouter_api_key
    ? await checkOpenrouterKey(patch.openrouter_api_key)
    : undefined;
  return json({
    config: redact(config),
    ...(telegram ? { telegram } : {}),
    ...(whatsapp ? { whatsapp } : {}),
    ...(openrouter ? { openrouter } : {}),
  });
}

/**
 * `/api/agents/:agentId/meta`: the admin's document. A user who could edit it could
 * unlock everything locked away from them.
 */
export async function handleMeta(call: AgentCall): Promise<Response | undefined> {
  if (!call.isAdmin) return notFound();
  const { request, env, url, agentId, reg } = call;
  if (request.method === "GET") return await getMeta(call);
  if (request.method === "PATCH") return await patchMeta(call);
  if (request.method === "POST") {
    const applied = await applyMeta(reg, await reg.meta(), env, url.origin, agentId);
    return json({ config: redact(applied.config), added: applied.added });
  }
  return undefined;
}

async function getMeta({ env, reg, agent }: AgentCall): Promise<Response> {
  const settings = await deploymentSettings(env);
  return json({
    agent,
    meta: redactMeta(await reg.meta()),
    // The agent's own settings too: `/config` is the users' and an admin need not be one.
    config: redact(await readConfig(env, reg)),
    models: modelCatalog(settings),
    // The deployment's menus, which this dialog narrows.
    capabilities: capabilitiesFor(DEFAULT_META, settings),
    mcp_catalog: settings.mcp_catalog,
    spend: await reg.spendState(),
  });
}

/**
 * Save the meta document, then any settings edited beside it: in that order, so a model
 * added to the list is offered by the time the setting that names it is written.
 */
async function patchMeta({ request, env, url, agentId, reg }: AgentCall): Promise<Response> {
  const body = await readJson<Partial<MetaSettings> & { config?: Partial<Config> }>(request);
  let meta: MetaSettings;
  try {
    meta = validateMeta(body, await reg.meta(), {
      creation: false,
      settings: await deploymentSettings(env),
    });
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }
  const saved = await reg.setMeta(meta);

  let config: Config | undefined;
  if (body.config) {
    let patch: Partial<Config>;
    try {
      patch = validateConfig(body.config);
    } catch (err) {
      return jsonError(errorMessage(err), 400);
    }
    const refused = unofferedModel(patch, saved.models);
    if (refused) return refused;
    // Not filtered by locks: this is the page that decides them.
    config = await writeConfig(env, reg, patch);
    await syncWebhook(config, url.origin, agentId, env.TELEGRAM_API_BASE);
    await syncWhatsappSubscription(config, env.WHATSAPP_API_BASE);
  }

  return json({ meta: redactMeta(saved), ...(config ? { config: redact(config) } : {}) });
}
