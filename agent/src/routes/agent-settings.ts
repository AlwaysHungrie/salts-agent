import { createRoute, z } from "@hono/zod-openapi";
import { type ApiApp, jsonOf, refusals } from "../api/app";
import {
  AgentRowSchema,
  CapabilitySchema,
  ConfigPatchSchema,
  ConfigSchema,
  GuestsSchema,
  McpCatalogEntrySchema,
  MetaPatchSchema,
  MetaSettingsSchema,
  ModelOptionSchema,
  SpendSchema,
} from "../api/schemas";
import { modelCatalog } from "../models";
import { TELEGRAM_WHITELIST_DEFAULTS } from "../capabilities";
import { type Config, DEFAULT_META, type MetaSettings, type ModelChoice } from "../registry";
import { deploymentSettings } from "../settings";
import { redact, validateConfig } from "../validation/config";
import { lockedColumns, redactMeta, validateMeta } from "../validation/meta";
import { capabilitiesFor, modelOptions, notedCapabilities } from "../worker/capability-views";
import { ApiError, errorMessage } from "../worker/http";
import { checkOpenrouterKey, syncWebhook, syncWhatsappSubscription } from "../worker/integrations";
import { agentFor, applyMeta } from "../worker/provisioning";
import { readConfig, writeConfig } from "../worker/stores";
import { type AgentCall, AgentParams, agentRoute, may } from "./agent";
import { guestsView } from "./guest";

/** Refuse a model the agent's meta document does not offer. */
function refuseUnofferedModel(patch: Partial<Config>, models: ModelChoice[]) {
  if (patch.model === undefined || !models.length) return;
  if (models.some((m) => m.id === patch.model)) return;
  throw new ApiError(400, `model not offered: ${patch.model}`);
}

const SyncResult = z.object({ ok: z.boolean(), error: z.string().optional() });

const ConfigViewSchema = z
  .object({
    agent: AgentRowSchema,
    config: ConfigSchema,
    spend: SpendSchema,
    member_limit: z.number(),
    models: z.array(ModelOptionSchema),
    capabilities: z.array(CapabilitySchema),
    locked: z.array(z.string()),
    guests: GuestsSchema,
    limits: z.object({
      max_files_per_message: z.number(),
      max_upload_bytes: z.record(z.string(), z.number()),
    }),
  })
  .openapi("ConfigView");

const ConfigSavedSchema = z
  .object({
    config: ConfigSchema,
    telegram: SyncResult.optional(),
    whatsapp: SyncResult.optional(),
    openrouter: SyncResult.extend({ label: z.string().optional() }).optional(),
  })
  .openapi("ConfigSaved");

const MetaViewSchema = z
  .object({
    agent: AgentRowSchema,
    meta: MetaSettingsSchema,
    config: ConfigSchema,
    models: z.array(ModelOptionSchema),
    capabilities: z.array(CapabilitySchema),
    mcp_catalog: z.array(McpCatalogEntrySchema),
    spend: SpendSchema,
  })
  .openapi("MetaView");

/** `/config` (the users' settings page) and `/meta` (the admin's document). */
export function settingsRoutes(app: ApiApp) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/agents/{agentId}/config",
      tags: ["Settings"],
      summary: "Read the agent's settings",
      middleware: [agentRoute(may.member)] as const,
      request: { params: AgentParams },
      responses: { 200: jsonOf(ConfigViewSchema), ...refusals(404) },
    }),
    async (c) => c.json(await getConfig(c.var.call), 200)
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/agents/{agentId}/config",
      tags: ["Settings"],
      summary: "Change the agent's settings",
      description: "Send only what changes. Settings the admin locked are dropped.",
      middleware: [agentRoute(may.member)] as const,
      request: {
        params: AgentParams,
        body: { content: { "application/json": { schema: ConfigPatchSchema } } },
      },
      responses: { 200: jsonOf(ConfigSavedSchema), ...refusals(400, 404) },
    }),
    async (c) => c.json(await patchConfig(c.var.call, c.req.valid("json") as Partial<Config>), 200)
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/agents/{agentId}/meta",
      tags: ["Admin"],
      summary: "Read the meta settings (admin)",
      middleware: [agentRoute(may.admin)] as const,
      request: { params: AgentParams },
      responses: { 200: jsonOf(MetaViewSchema), ...refusals(404) },
    }),
    async (c) => c.json(await getMeta(c.var.call), 200)
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/agents/{agentId}/meta",
      tags: ["Admin"],
      summary: "Replace the meta settings (admin)",
      description:
        "The whole document: omitted parts come back empty. `config` saves agent settings alongside, past the locks.",
      middleware: [agentRoute(may.admin)] as const,
      request: {
        params: AgentParams,
        body: { content: { "application/json": { schema: MetaPatchSchema } } },
      },
      responses: {
        200: jsonOf(
          z
            .object({ meta: MetaSettingsSchema, config: ConfigSchema.optional() })
            .openapi("MetaSaved")
        ),
        ...refusals(400, 404),
      },
    }),
    async (c) =>
      c.json(
        await patchMeta(
          c.var.call,
          c.req.valid("json") as Partial<MetaSettings> & { config?: Partial<Config> }
        ),
        200
      )
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/agents/{agentId}/meta",
      tags: ["Admin"],
      summary: "Apply the meta defaults to the agent's settings (admin)",
      middleware: [agentRoute(may.admin)] as const,
      request: { params: AgentParams },
      responses: {
        200: jsonOf(z.object({ config: ConfigSchema, added: z.array(z.string()) })),
        ...refusals(404),
      },
    }),
    async (c) => {
      const { env, url, agentId, reg } = c.var.call;
      const applied = await applyMeta(reg, await reg.meta(), env, url.origin, agentId);
      return c.json({ config: redact(applied.config), added: applied.added }, 200);
    }
  );
}

async function getConfig({ env, reg, agent, email, access }: AgentCall) {
  const meta = await reg.meta();
  const settings = await deploymentSettings(env);
  return {
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
  };
}

async function patchConfig({ env, url, agentId, reg }: AgentCall, body: Partial<Config>) {
  let patch: Partial<Config>;
  try {
    patch = validateConfig(body);
  } catch (err) {
    throw new ApiError(400, errorMessage(err));
  }
  const meta = await reg.meta();
  refuseUnofferedModel(patch, meta.models);
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
  return {
    config: redact(config),
    ...(telegram ? { telegram } : {}),
    ...(whatsapp ? { whatsapp } : {}),
    ...(openrouter ? { openrouter } : {}),
  };
}

/**
 * The admin's document, with the deployment's menus it narrows. A user who could edit it
 * could unlock everything locked away from them, so `/meta` is the admin's alone.
 */
async function getMeta({ env, reg, agent }: AgentCall) {
  const settings = await deploymentSettings(env);
  return {
    agent,
    meta: redactMeta(await reg.meta()),
    // The agent's own settings too: `/config` is the users' and an admin need not be one.
    config: redact(await readConfig(env, reg)),
    models: modelCatalog(settings),
    // The deployment's menus, which this dialog narrows.
    capabilities: capabilitiesFor(DEFAULT_META, settings),
    mcp_catalog: settings.mcp_catalog,
    spend: await reg.spendState(),
  };
}

/**
 * Save the meta document, then any settings edited beside it: in that order, so a model
 * added to the list is offered by the time the setting that names it is written.
 */
async function patchMeta(
  { env, url, agentId, reg }: AgentCall,
  body: Partial<MetaSettings> & { config?: Partial<Config> }
) {
  let meta: MetaSettings;
  try {
    meta = validateMeta(body, await reg.meta(), {
      creation: false,
      settings: await deploymentSettings(env),
    });
  } catch (err) {
    throw new ApiError(400, errorMessage(err));
  }
  const saved = await reg.setMeta(meta);

  let config: Config | undefined;
  if (body.config) {
    let patch: Partial<Config>;
    try {
      patch = validateConfig(body.config);
    } catch (err) {
      throw new ApiError(400, errorMessage(err));
    }
    refuseUnofferedModel(patch, saved.models);
    // Not filtered by locks: this is the page that decides them.
    config = await writeConfig(env, reg, patch);
    await syncWebhook(config, url.origin, agentId, env.TELEGRAM_API_BASE);
    await syncWhatsappSubscription(config, env.WHATSAPP_API_BASE);
  }

  return { meta: redactMeta(saved), ...(config ? { config: redact(config) } : {}) };
}
