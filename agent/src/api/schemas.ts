import { z } from "@hono/zod-openapi";
import type { Capability, ScheduledTask } from "../capabilities";
import type { McpServerView } from "../mcp";
import type { ModelOption } from "../models";
import type {
  AgentRow,
  ApiKeyInfo,
  Config,
  McpCatalogEntry,
  MetaSettings,
  SessionPage,
  SessionRow,
} from "../registry";
import type { publicAttachment } from "../session/files";
import type { StoredMessage, TranscriptPage } from "../session/types";
import { CAPABILITY_FLAGS } from "../validation/config";

/**
 * The shapes the API takes and returns, as zod schemas: Hono validates requests against
 * them and the OpenAPI document is generated from them. Each one that mirrors a type the
 * Worker already has is pinned to it below, so the two cannot drift apart.
 */

/** True when A and B are the same type, both ways round. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Fails to compile unless its argument is `true`. */
function pin<T extends true>(): T | void {}

export const ErrorSchema = z
  .object({ error: z.string() })
  .openapi("Error", { example: { error: "Agent not found." } });

export const OkSchema = z.object({ ok: z.boolean() }).openapi("Ok");

export const AgentRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    created_at: z.number(),
    updated_at: z.number(),
    allowed_emails: z.string().openapi({ description: "Members, one address per line." }),
    admin_email: z
      .string()
      .openapi({ description: "The admin's address; empty unless the caller is the admin." }),
    fleet_id: z.string(),
    fleet_name: z.string(),
  })
  .openapi("Agent");
pin<Same<z.infer<typeof AgentRowSchema>, AgentRow>>();

const flag = z.number().int().openapi({ description: "1 on, 0 off." });

export const ConfigSchema = z
  .object({
    model: z.string(),
    agent_name: z.string(),
    system_prompt: z.string(),
    private_notes: z.string(),
    public_notes: z.string(),
    temperature: z.number(),
    max_tokens: z.number(),
    reasoning_effort: z.enum(["off", "low", "medium", "high"]),
    context_messages: z.number(),
    cap_web_search: flag,
    cap_url_fetch: flag,
    cap_file_ingest: flag,
    cap_vision: flag,
    cap_image_generation: flag,
    cap_audio_input: flag,
    cap_voice_output: flag,
    cap_scheduled_tasks: flag,
    cap_memory: flag,
    cap_telegram: flag,
    cap_whatsapp: flag,
    cap_mcp: flag,
    openrouter_api_key: z.string(),
    brave_api_key: z.string(),
    searxng_url: z.string(),
    searxng_token: z.string(),
    image_model: z.string(),
    transcription_model: z.string(),
    voice_model: z.string(),
    telegram_bot_token: z.string(),
    telegram_bot_username: z.string(),
    telegram_user_whitelist: z.string(),
    telegram_group_whitelist: z.string(),
    whatsapp_phone_number_id: z.string(),
    whatsapp_waba_id: z.string(),
    whatsapp_access_token: z.string(),
    whatsapp_app_secret: z.string(),
    whatsapp_verify_token: z.string(),
    whatsapp_number: z.string(),
  })
  .openapi("Config", { description: "The agent's settings. Secrets read back masked." });
pin<Same<z.infer<typeof ConfigSchema>, Config>>();

/** A settings patch: any subset, and the capability switches also take booleans. */
const ConfigPatchShape = ConfigSchema.partial().extend(
  Object.fromEntries(
    CAPABILITY_FLAGS.map((key) => [key, z.union([z.number(), z.boolean()]).optional()])
  ) as Record<
    (typeof CAPABILITY_FLAGS)[number],
    z.ZodOptional<z.ZodUnion<[z.ZodNumber, z.ZodBoolean]>>
  >
);

export const SpendSchema = z
  .object({ usd: z.number(), limit: z.number(), month: z.string() })
  .openapi("Spend", { description: "This month's model spend and its ceiling (0 = none)." });

export const ModelOptionSchema = z
  .object({ id: z.string(), label: z.string(), vision: z.boolean() })
  .openapi("ModelOption");
pin<Same<z.infer<typeof ModelOptionSchema>, ModelOption>>();

/**
 * A capability as the settings page draws it. Typed exactly, documented loosely: it is
 * the page's own menu, not something a script needs to read field by field.
 */
export const CapabilitySchema = z.custom<Capability>().openapi("Capability", {
  type: "object",
  description: "One capability: its switch (`flag`), tools and credential fields.",
});

export const GuestsSchema = z
  .object({ enabled: z.boolean(), emails: z.array(z.string()) })
  .openapi("Guests");

export const McpCatalogEntrySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    auth: z.enum(["none", "headers", "oauth"]),
    icon: z.string().optional(),
    letter: z.string().optional(),
    color: z.string().optional(),
  })
  .openapi("McpCatalogEntry");
pin<Same<z.infer<typeof McpCatalogEntrySchema>, McpCatalogEntry>>();

const tunable = z
  .object({
    model: z.string(),
    system_prompt: z.string(),
    temperature: z.number(),
    max_tokens: z.number(),
    reasoning_effort: z.enum(["off", "low", "medium", "high"]),
    context_messages: z.number(),
    openrouter_api_key: z.string(),
  })
  .partial();

export const MetaSettingsSchema = z
  .object({
    models: z.array(z.object({ id: z.string(), vision: z.boolean() })),
    defaults: tunable,
    locked: z.array(z.string()),
    capabilities: z.record(
      z.string(),
      z.object({
        enabled: z.boolean().optional(),
        fields: z.record(z.string(), z.string()).optional(),
      })
    ),
    field_options: z.record(z.string(), z.array(z.string())),
    mcp: z.object({
      templates: z.array(z.string()),
      catalog: z.array(McpCatalogEntrySchema),
      servers: z.array(
        z.object({
          name: z.string(),
          url: z.string(),
          auth: z.enum(["none", "headers", "oauth"]),
          headers: z.record(z.string(), z.string()),
        })
      ),
      user_servers: z.boolean(),
    }),
    monthly_spend_limit: z.number(),
    member_limit: z.number(),
  })
  .openapi("MetaSettings", {
    description: "The admin's defaults, locks and limits for the agent.",
  });
pin<Same<z.infer<typeof MetaSettingsSchema>, MetaSettings>>();

export const SessionRowSchema = z
  .object({
    id: z.string().openapi({ description: "`<agentId>~<local>`." }),
    title: z.string(),
    owner_email: z.string(),
    created_at: z.number(),
    updated_at: z.number(),
    object_id: z.string(),
    source: z.string(),
    chat_id: z.string(),
    chat_type: z.string(),
    chat_username: z.string(),
    chat_thread_id: z.string(),
  })
  .openapi("Session");
pin<Same<z.infer<typeof SessionRowSchema>, SessionRow>>();

export const SessionPageSchema = z
  .object({ sessions: z.array(SessionRowSchema), has_more: z.boolean(), cursor: z.string() })
  .openapi("SessionPage");
pin<Same<z.infer<typeof SessionPageSchema>, SessionPage>>();

export const ApiKeyInfoSchema = z
  .object({ role: z.enum(["admin", "user"]), hint: z.string(), created_at: z.number() })
  .openapi("ApiKey");
pin<Same<z.infer<typeof ApiKeyInfoSchema>, ApiKeyInfo>>();

const mcpTool = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});

export const McpServerSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    auth: z.enum(["none", "headers", "oauth"]),
    enabled: z.number(),
    oauth_client_id: z.string(),
    oauth_expires_at: z.number(),
    oauth_scope: z.string(),
    oauth_token_url: z.string(),
    oauth_authorize_url: z.string(),
    oauth_registration_url: z.string(),
    oauth_resource: z.string(),
    oauth_return_to: z.string(),
    tools_synced_at: z.number(),
    last_error: z.string(),
    created_at: z.number(),
    headers: z.record(z.string(), z.string()),
    tools: z.array(mcpTool),
    disabled_tools: z.array(z.string()),
    connected: z.boolean(),
  })
  .openapi("McpServer");
pin<Same<z.infer<typeof McpServerSchema>, McpServerView>>();

export const AttachmentSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["text", "image", "pdf", "sheet"]),
    name: z.string(),
    mime: z.string(),
    bytes: z.number(),
    chars: z.number(),
    preview: z.string(),
    thumb: z.boolean(),
  })
  .openapi("Attachment");
pin<Same<z.infer<typeof AttachmentSchema>, ReturnType<typeof publicAttachment>>>();

export const MessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    ts: z.number(),
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    cost_usd: z.number(),
    ms: z.number(),
    attachments: z.array(AttachmentSchema),
    steps: z.string().openapi({ description: "JSON array of the turn's tool steps." }),
  })
  .openapi("Message");
pin<Same<z.infer<typeof MessageSchema>, StoredMessage>>();

export const TranscriptPageSchema = z
  .object({
    messages: z.array(MessageSchema),
    has_more: z.boolean(),
    offset: z.number(),
    total: z.number(),
  })
  .openapi("TranscriptPage");
pin<Same<z.infer<typeof TranscriptPageSchema>, TranscriptPage>>();

export const TaskSchema = z
  .object({ id: z.string(), prompt: z.string(), when: z.string() })
  .openapi("Task");
pin<Same<z.infer<typeof TaskSchema>, ScheduledTask>>();

/** What every session-object answer carries beside its body. */
export const SessionMetaSchema = z
  .object({ session: z.string(), request: z.record(z.string(), z.unknown()) })
  .openapi("SessionMeta");

/**
 * A request body documented as `schema` but checked by the Worker's own validator, whose
 * messages (and clamping) callers already rely on. Only "is an object" is checked here.
 */
export function checkedByHandler<T extends z.ZodType>(schema: T, name: string) {
  const { $schema: _drop, ...shape } = z.toJSONSchema(schema, {
    target: "openapi-3.0",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return z
    .custom<z.input<T>>((v) => typeof v === "object" && v !== null && !Array.isArray(v), {
      message: "body must be a JSON object",
    })
    .openapi(name, shape);
}

export const MetaPatchSchema = checkedByHandler(
  MetaSettingsSchema.partial().extend({ config: ConfigPatchShape.optional() }),
  "MetaPatch"
);

export const ConfigPatchSchema = checkedByHandler(ConfigPatchShape, "ConfigPatch");
