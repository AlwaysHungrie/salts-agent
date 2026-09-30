/** What `GET /` answers: a map of the Worker's routes, for whoever is poking at it. */
export const ROUTE_INDEX = {
  routes: {
    agents:
      "GET|POST /api/agents (GET: ?limit&cursor&fleet; DELETE: ?fleet&limit -> one batch), GET|PATCH|DELETE /api/agents/:agentId",
    config: "GET|PATCH /api/agents/:agentId/config",
    meta: "GET|PATCH /api/agents/:agentId/meta, POST .../meta (apply defaults)",
    catalog: "GET /api/agents/catalog  -> models and capabilities",
    fleets:
      "GET|PATCH /api/fleets/:fleetId (PATCH: one batch, ?cursor to continue), POST /api/fleets/:fleetId/agents",
    mcp: "GET|POST /api/agents/:agentId/mcp, PATCH|DELETE .../mcp/:id, POST .../mcp/:id/{connect,disconnect,refresh}",
    sessions: "GET|POST /api/agents/:agentId/sessions  (GET: ?limit&cursor)",
    session: "PATCH|DELETE /api/sessions/:sessionId",
    fork: "POST /api/sessions/:sessionId/fork  { count }",
    unstick: "POST /api/sessions/:sessionId/unstick",
    stream: "POST /agents/session-agent/:sessionId/stream  { message }  -> SSE",
    live: "GET /agents/session-agent/:sessionId/live  -> SSE, or 204 when idle",
    chat: "POST /agents/session-agent/:sessionId/chat  { message }",
    messages: "GET /agents/session-agent/:sessionId/messages  ?limit&before",
    files: "GET|POST /agents/session-agent/:sessionId/files, GET|DELETE .../files/:fileId",
    tasks: "GET /agents/session-agent/:sessionId/tasks, DELETE .../tasks/:taskId",
    metrics: "GET /agents/session-agent/:sessionId/metrics",
    telegram: "POST /telegram/webhook/:agentId",
    whatsapp:
      "GET|POST /whatsapp/webhook/:agentId  -> GET verifies the subscription, POST delivers a message",
    searxng:
      "POST /searxng/:agentId/url { url }  -> Authorization: Bearer <the agent's SearXNG token>",
    admin:
      "POST /api/admin/business-account { email, agent_limit }, GET /api/admin/stats  -> owner only, via API_SECRET",
    settings:
      "GET /api/admin/settings -> { settings, missing, fields }; PATCH /api/admin/settings { <field>: value } -> owner only, via API_SECRET",
    business_requests:
      "POST /api/business-requests { increase } -> signed-in caller; GET /api/admin/business-requests, POST .../:id/approve, DELETE .../:id -> owner only, via API_SECRET",
  },
  note: "A session id is `<agentId>~<local>`; every /agents/session-agent route takes that whole id.",
};
