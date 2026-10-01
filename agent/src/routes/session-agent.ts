import { createRoute, z } from "@hono/zod-openapi";
import { routeAgentRequest } from "agents";
import type { Context } from "hono";
import { type ApiApp, type ApiEnv, jsonOf, keepForward, refusals } from "../api/app";
import {
  AttachmentSchema,
  OkSchema,
  SessionMetaSchema,
  TaskSchema,
  TranscriptPageSchema,
} from "../api/schemas";
import { jsonError } from "../worker/http";
import { SessionParams } from "./sessions";

/**
 * `/agents/session-agent/{sessionId}/…`: talking to one session. The session object
 * answers these itself; the Worker validates and documents them, then hands the request
 * on untouched. The gate has already checked the caller may use the session.
 *
 * Only these are reachable from outside. The object's other routes (export, import,
 * channel deliveries, destroy) are the Worker's own and are called directly.
 */

/**
 * Hand the original request to the session object. Its answer is the object's to shape,
 * so it is passed back as it is rather than checked against the route's schema here:
 * typed as `never`, which every route's response type accepts.
 */
async function forward(c: Context<ApiEnv>): Promise<never> {
  const res = await routeAgentRequest(c.var.forward, c.env);
  return (res ?? jsonError("not found", 404)) as never;
}

/** Every session-object answer carries `_meta` beside its body. */
const withMeta = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ ...shape, _meta: SessionMetaSchema });

const FileParams = SessionParams.extend({
  fileId: z.string().openapi({ param: { name: "fileId", in: "path" } }),
});

const sse = (description: string) => ({
  description,
  content: { "text/event-stream": { schema: z.string() } },
});

const EVENTS =
  "Server-sent events, each `data: {json}`: `delta` (text), `tool` and `tool_done` (tool calls), `usage`, `error`, then the end of the stream.";

const tag = ["Messages"];
const middleware = [keepForward];

const chat = createRoute({
  method: "post",
  path: "/agents/session-agent/{sessionId}/chat",
  tags: tag,
  summary: "Send a message and wait for the whole reply",
  middleware,
  request: {
    params: SessionParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({ message: z.string() })
            .openapi({ example: { message: "Hello, who are you?" } }),
        },
      },
    },
  },
  responses: { 200: jsonOf(withMeta({ reply: z.string() })), ...refusals(400, 404) },
});

const stream = createRoute({
  method: "post",
  path: "/agents/session-agent/{sessionId}/stream",
  tags: tag,
  summary: "Send a message and stream the reply",
  description: EVENTS,
  middleware,
  request: {
    params: SessionParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              message: z.string(),
              retry: z
                .boolean()
                .optional()
                .openapi({ description: "Answer the last message again." }),
            })
            .openapi({ example: { message: "Hello, who are you?" } }),
        },
      },
    },
  },
  responses: { 200: sse("The reply, as it is written."), ...refusals(400, 404) },
});

const messages = createRoute({
  method: "get",
  path: "/agents/session-agent/{sessionId}/messages",
  tags: tag,
  summary: "Read the transcript, newest page first",
  middleware,
  request: {
    params: SessionParams,
    query: z.object({
      limit: z.string().optional().openapi({ description: "Page size." }),
      before: z
        .string()
        .optional()
        .openapi({ description: "A message id: the page that ends before it." }),
    }),
  },
  responses: {
    200: jsonOf(TranscriptPageSchema.extend({ _meta: SessionMetaSchema })),
    ...refusals(404),
  },
});

const summary = createRoute({
  method: "get",
  path: "/agents/session-agent/{sessionId}/summary",
  tags: tag,
  summary: "Message count, token use and cost so far",
  middleware,
  request: { params: SessionParams },
  responses: {
    200: jsonOf(
      withMeta({
        session: z.string(),
        messages: z.number(),
        llm: z.object({
          model: z.string(),
          prompt_tokens: z.number(),
          completion_tokens: z.number(),
          cost_usd: z.number(),
        }),
        tasks: z.array(TaskSchema),
        sqlite_bytes: z.number(),
        sub_agents: z.number(),
      })
    ),
    ...refusals(404),
  },
});

const reset = createRoute({
  method: "post",
  path: "/agents/session-agent/{sessionId}/reset",
  tags: tag,
  summary: "Clear the session: messages, files and usage",
  middleware,
  request: { params: SessionParams },
  responses: { 200: jsonOf(withMeta(OkSchema.shape)), ...refusals(404) },
});

const listFiles = createRoute({
  method: "get",
  path: "/agents/session-agent/{sessionId}/files",
  tags: ["Files"],
  summary: "Files uploaded and not yet sent with a message",
  middleware,
  request: { params: SessionParams },
  responses: {
    200: jsonOf(withMeta({ attachments: z.array(AttachmentSchema) })),
    ...refusals(404),
  },
});

const upload = createRoute({
  method: "post",
  path: "/agents/session-agent/{sessionId}/files",
  tags: ["Files"],
  summary: "Upload a file for the next message",
  description:
    "The next message sent to the session carries every file uploaded since the last one.",
  middleware,
  request: {
    params: SessionParams,
    body: {
      required: true,
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z.any().openapi({ type: "string", format: "binary" }),
            thumbnail: z.any().optional().openapi({
              type: "string",
              format: "binary",
              description: "A PNG of a PDF's first page.",
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: jsonOf(withMeta({ attachment: AttachmentSchema })),
    ...refusals(400, 404, 413),
  },
});

const download = createRoute({
  method: "get",
  path: "/agents/session-agent/{sessionId}/files/{fileId}",
  tags: ["Files"],
  summary: "Download a file's bytes",
  middleware,
  request: { params: FileParams },
  responses: {
    200: {
      description: "The file.",
      content: {
        "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) },
      },
    },
    ...refusals(404),
  },
});

const thumbnail = createRoute({
  method: "get",
  path: "/agents/session-agent/{sessionId}/files/{fileId}/thumb",
  tags: ["Files"],
  summary: "Download a PDF's first-page thumbnail",
  middleware,
  request: { params: FileParams },
  responses: {
    200: {
      description: "A PNG.",
      content: { "image/png": { schema: z.string().openapi({ format: "binary" }) } },
    },
    ...refusals(404),
  },
});

const removeFile = createRoute({
  method: "delete",
  path: "/agents/session-agent/{sessionId}/files/{fileId}",
  tags: ["Files"],
  summary: "Remove an uploaded file before it is sent",
  middleware,
  request: { params: FileParams },
  responses: { 200: jsonOf(withMeta(OkSchema.shape)), ...refusals(404) },
});

const listTasks = createRoute({
  method: "get",
  path: "/agents/session-agent/{sessionId}/tasks",
  tags: ["Tasks"],
  summary: "Scheduled tasks the agent set itself",
  middleware,
  request: { params: SessionParams },
  responses: { 200: jsonOf(withMeta({ tasks: z.array(TaskSchema) })), ...refusals(404) },
});

const cancelTask = createRoute({
  method: "delete",
  path: "/agents/session-agent/{sessionId}/tasks/{taskId}",
  tags: ["Tasks"],
  summary: "Cancel a scheduled task",
  middleware,
  request: {
    params: SessionParams.extend({
      taskId: z.string().openapi({ param: { name: "taskId", in: "path" } }),
    }),
  },
  responses: { 200: jsonOf(withMeta(OkSchema.shape)), ...refusals(404) },
});

const live = createRoute({
  method: "get",
  path: "/agents/session-agent/{sessionId}/live",
  tags: tag,
  summary: "Attach to a reply still being written",
  description: `${EVENTS} 204 when nothing is in flight.`,
  middleware,
  request: {
    params: SessionParams,
    query: z.object({
      has: z
        .string()
        .optional()
        .openapi({ description: "The id of the last reply the caller already holds." }),
    }),
  },
  responses: {
    200: sse("The reply in flight."),
    204: { description: "Nothing in flight." },
    ...refusals(404),
  },
});

export function sessionAgentRoutes(app: ApiApp) {
  for (const route of [
    chat,
    stream,
    live,
    messages,
    summary,
    reset,
    listFiles,
    upload,
    download,
    thumbnail,
    removeFile,
    listTasks,
    cancelTask,
  ]) {
    app.openapi(route, forward);
  }
}
