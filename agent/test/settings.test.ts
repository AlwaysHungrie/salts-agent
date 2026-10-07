import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  SettingsError,
  SettingsIncompleteError,
  completeSettings,
  missingSettings,
  validateSettingsPatch,
} from "../src/settings";
import { normalizeEmails, sessionLimitMessage } from "../src/registry";
import { SHIPPED } from "./shipped";
import { signedIn } from "./clerk";

/**
 * The deployment's own knobs.
 *
 * Two halves. The completeness check and the validator are pure and tested directly,
 * because they are where a wrong answer is silent — a patch that stores a bad number
 * keeps working until something enforces it. The routes are tested over HTTP, because what matters
 * about them is the gate and the fact that a written ceiling is the one actually
 * enforced a moment later.
 *
 * Every test that writes restores the shipped document afterwards. The settings live
 * in the one directory object, the pool does not roll storage back, and a value left
 * behind would change what every later test in the run is held to.
 */

const SECRET = env.API_SECRET as string;
const BASE = "https://worker.test";

function asOwner(init: RequestInit = {}) {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-api-secret": SECRET,
      ...(init.headers as Record<string, string> | undefined),
    },
  };
}

const patch = (body: unknown) =>
  SELF.fetch(
    `${BASE}/api/admin/settings`,
    asOwner({ method: "PATCH", body: JSON.stringify(body) })
  );

const reset = () => patch(SHIPPED);

/** Drop the stored document outright, the way a fresh deployment starts. */
async function clear() {
  await env.AgentDirectory.get(env.AgentDirectory.idFromName("root")).clearSettings();
  // An empty patch through the route: a no-op write that drops the Worker's cached copy.
  await patch({});
}

describe("a complete document", () => {
  it("is what the admin CLI ships", () => {
    // The CLI's defaults are the only values a fresh deployment can start from, so
    // they have to be a document this Worker accepts, complete, as they stand.
    expect(missingSettings(SHIPPED)).toEqual([]);
    expect(validateSettingsPatch(SHIPPED, {})).toEqual(SHIPPED);
  });

  it("names every missing field, nested ones by key", () => {
    const { max_sessions: _, ...rest } = structuredClone(SHIPPED);
    const partial = {
      ...rest,
      max_upload_bytes: { text: 1, pdf: 1, image: 1 },
      config_defaults: { ...SHIPPED.config_defaults, cap_mcp: undefined },
    } as never;
    expect(missingSettings(partial)).toEqual([
      "max_sessions",
      "max_upload_bytes.audio",
      "max_upload_bytes.sheet",
      "config_defaults.cap_mcp",
    ]);
  });

  it("refuses to stand in for anything", () => {
    // No shipped values to fill a gap with: an empty document is every field missing.
    expect(() => completeSettings({})).toThrow(SettingsIncompleteError);
    try {
      completeSettings({});
    } catch (err) {
      expect((err as SettingsIncompleteError).missing).toContain("max_tool_rounds");
    }
  });

  it("counts an empty model list and a blank default model as missing", () => {
    expect(missingSettings({ ...SHIPPED, models: [] })).toEqual(["models"]);
    expect(missingSettings({ ...SHIPPED, default_model: " " })).toEqual(["default_model"]);
  });

  it("keeps a zero as a value rather than reading it as absent", () => {
    // `max_tokens: 0` means "no cap", so absence cannot be a sentinel value.
    expect(completeSettings(SHIPPED).config_defaults.max_tokens).toBe(0);
  });
});

describe("validating a patch", () => {
  it("refuses a key that is not a setting", () => {
    // Refused rather than ignored: a typo that silently did nothing looks exactly like
    // a limit that does not work.
    expect(() => validateSettingsPatch({ max_session: 4 }, {})).toThrow(SettingsError);
  });

  it("refuses a number outside the field's range", () => {
    expect(() => validateSettingsPatch({ max_sessions: 0 }, {})).toThrow(/whole number/);
    expect(() => validateSettingsPatch({ max_tool_rounds: 1.5 }, {})).toThrow(/whole number/);
  });

  it("merges into the document already stored", () => {
    const first = validateSettingsPatch({ max_sessions: 4 }, {});
    const second = validateSettingsPatch({ max_members: 9 }, first);
    expect(second).toEqual({ max_sessions: 4, max_members: 9 });
  });

  it("refuses to unset a field, top-level or nested", () => {
    // Every field is required, so there is nothing for "unset" to fall back to.
    expect(() => validateSettingsPatch({ max_sessions: null }, SHIPPED)).toThrow(/cannot be unset/);
    expect(() =>
      validateSettingsPatch({ config_defaults: { temperature: null } }, SHIPPED)
    ).toThrow(/cannot be unset/);
  });

  it("merges upload ceilings per kind rather than replacing them", () => {
    const stored = validateSettingsPatch({ max_upload_bytes: { pdf: 99 } }, SHIPPED);
    expect(stored.max_upload_bytes).toEqual({ ...SHIPPED.max_upload_bytes, pdf: 99 });
  });

  it("refuses an empty model list and a blank default model", () => {
    expect(() => validateSettingsPatch({ models: [] }, {})).toThrow(/at least one/);
    expect(() => validateSettingsPatch({ default_model: "" }, {})).toThrow(/model id/);
  });

  it("refuses a config column that is not settable deployment-wide", () => {
    // Secrets and per-agent columns are not defaults anybody should be able to set
    // for every agent at once.
    expect(() =>
      validateSettingsPatch({ config_defaults: { telegram_bot_token: "x" } }, {})
    ).toThrow(/not a settable column/);
  });

  it("checks a settable config column's own range", () => {
    expect(() => validateSettingsPatch({ config_defaults: { temperature: 5 } }, {})).toThrow(
      /between 0 and 2/
    );
    expect(() =>
      validateSettingsPatch({ config_defaults: { reasoning_effort: "extreme" } }, {})
    ).toThrow(/off, low, medium or high/);
  });

  it("stores a capability switch as the integer the column holds", () => {
    const stored = validateSettingsPatch({ config_defaults: { cap_web_search: true } }, {});
    expect(stored.config_defaults).toEqual({ cap_web_search: 1 });
  });

  it("refuses a page default above its own ceiling", () => {
    // It would clamp on every read, which reads as the default being ignored.
    expect(() => validateSettingsPatch({ message_page: 500 }, SHIPPED)).toThrow(
      /cannot exceed max_message_page/
    );
  });

  it("takes a model list and fills in the label and vision", () => {
    const stored = validateSettingsPatch({ models: [{ id: "a/b" }] }, {});
    expect(stored.models).toEqual([{ id: "a/b", label: "a/b", vision: true }]);
  });

  it("refuses a field_options key that is not a choice field", () => {
    expect(() => validateSettingsPatch({ field_options: { temperature: ["a/b"] } }, {})).toThrow(
      /not a choice field/
    );
  });

  it("refuses a field_options entry that is not a model id", () => {
    expect(() =>
      validateSettingsPatch(
        { field_options: { voice_model: [{ id: "not a model", label: "X" }] } },
        {}
      )
    ).toThrow(/not an OpenRouter model id/);
  });

  it("refuses a field_options menu that is empty, unset, or bare ids", () => {
    for (const menu of [[], null, ["openai/gpt-audio"]]) {
      expect(() => validateSettingsPatch({ field_options: { voice_model: menu } }, {})).toThrow();
    }
  });

  it("names each model on a menu, the id standing in for a missing label", () => {
    const next = validateSettingsPatch(
      { field_options: { voice_model: [{ id: "openai/gpt-audio" }, { id: "openai/gpt-audio" }] } },
      {}
    );
    expect(next.field_options).toEqual({
      voice_model: [{ id: "openai/gpt-audio", label: "openai/gpt-audio" }],
    });
  });

  it("counts a menu column as unset while it is absent or still holds bare ids", () => {
    const stored = {
      ...SHIPPED,
      field_options: {
        image_model: SHIPPED.field_options.image_model,
        voice_model: ["openai/gpt-audio"],
      },
    } as never;
    expect(missingSettings(stored)).toEqual([
      "field_options.transcription_model",
      "field_options.voice_model",
    ]);
  });

  it("refuses an MCP catalogue entry that names no url", () => {
    expect(() => validateSettingsPatch({ mcp_catalog: [{ id: "x", name: "X" }] }, {})).toThrow(
      /needs an id, a name and a url/
    );
  });

  it("stores an MCP template's SVG icon as a data URL, raw markup or not", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>';
    const entry = { id: "x", name: "X", url: "https://x.test/mcp", auth: "none" };
    const raw = validateSettingsPatch({ mcp_catalog: [{ ...entry, icon: svg }] }, {});
    const icon = raw.mcp_catalog![0].icon!;
    expect(icon).toBe(`data:image/svg+xml;base64,${btoa(svg)}`);
    const again = validateSettingsPatch({ mcp_catalog: [{ ...entry, icon }] }, {});
    expect(again.mcp_catalog![0].icon).toBe(icon);
  });

  it("refuses an MCP icon that is not SVG, or past max_icon_bytes", () => {
    const entry = { id: "x", name: "X", url: "https://x.test/mcp", auth: "none" };
    expect(() =>
      validateSettingsPatch({ mcp_catalog: [{ ...entry, icon: "data:image/png;base64,AAAA" }] }, {})
    ).toThrow(/must be an SVG/);
    const big = `<svg>${"x".repeat(100)}</svg>`;
    expect(() =>
      validateSettingsPatch({ max_icon_bytes: 50, mcp_catalog: [{ ...entry, icon: big }] }, {})
    ).toThrow(/the most is 50/);
  });

  it("ships Notion with its own logo", () => {
    const notion = SHIPPED.mcp_catalog.find((t) => t.id === "notion");
    expect(notion?.icon).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(() =>
      validateSettingsPatch({ mcp_catalog: SHIPPED.mcp_catalog }, SHIPPED as never)
    ).not.toThrow();
  });

  it("refuses mcp_templates, and drops it from a document saved before its removal", () => {
    expect(() => validateSettingsPatch({ mcp_templates: [] }, {})).toThrow(/unknown setting/);
    const stored = { max_sessions: 5, mcp_templates: ["notion"] } as never;
    expect(validateSettingsPatch({ max_sessions: 6 }, stored)).toEqual({ max_sessions: 6 });
  });
});

describe("the access list ceiling", () => {
  it("counts against the number it is given", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `u${i}@x.com`);
    expect(() => normalizeEmails(eleven, 10)).toThrow(/at most 10 addresses/);
    expect(normalizeEmails(eleven, 11).split("\n")).toHaveLength(11);
  });
});

describe("the admin settings route", () => {
  afterEach(async () => {
    await reset();
  });

  it("refuses a caller with no secret", async () => {
    const res = await SELF.fetch(`${BASE}/api/admin/settings`);
    expect(res.status).toBe(401);
  });

  it("serves the document, what it is missing and the field list", async () => {
    const res = await SELF.fetch(`${BASE}/api/admin/settings`, asOwner());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: Record<string, unknown>;
      missing: string[];
      fields: { key: string; kind: string; doc: string; group: string }[];
    };
    expect(body.settings.max_sessions).toBe(SHIPPED.max_sessions);
    expect(body.missing).toEqual([]);
    // The CLI draws itself from this, so every setting has to be described by it.
    expect(body.fields.map((f) => f.key)).toContain("max_upload_bytes");
    expect(body.fields.every((f) => f.doc.length > 0)).toBe(true);
    // And sorted onto its limits or defaults tab.
    const group = Object.fromEntries(body.fields.map((f) => [f.key, f.group]));
    expect(group.max_sessions).toBe("limit");
    expect(group.max_upload_bytes).toBe("limit");
    expect(group.system_prompt).toBe("default");
    expect(group.config_defaults).toBe("default");
  });

  it("saves a setting and reports what is now in force", async () => {
    const res = await patch({ max_sessions: 3 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: { max_sessions: number; max_agent_bytes: number };
      missing: string[];
    };
    expect(body.settings.max_sessions).toBe(3);
    expect(body.settings.max_agent_bytes).toBe(SHIPPED.max_agent_bytes);
    expect(body.missing).toEqual([]);
  });

  it("answers a bad value with the reason rather than a 500", async () => {
    const res = await patch({ max_sessions: -1 });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toMatch(/whole number/);
  });

  it("refuses an unknown method, reset included", async () => {
    // There is no reset: with nothing to fall back to, it would stop the deployment.
    for (const method of ["PUT", "DELETE"]) {
      const res = await SELF.fetch(`${BASE}/api/admin/settings`, asOwner({ method }));
      expect(res.status).toBe(405);
    }
  });
});

describe("a deployment with incomplete settings", () => {
  afterEach(async () => {
    await reset();
  });

  it("refuses every ordinary request with a message fit for end users", async () => {
    await clear();
    await patch({ max_sessions: 9 });
    const res = await SELF.fetch(
      `${BASE}/api/agents`,
      asOwner({ headers: signedIn("refused@x.com") })
    );
    expect(res.status).toBe(503);
    // The UI shows this verbatim: no field names, no tooling. The list is the owner's,
    // over the admin route.
    expect(await res.json()).toEqual({ error: "Deployment is missing default settings" });
    const admin = await SELF.fetch(`${BASE}/api/admin/settings`, asOwner());
    const { missing } = await admin.json<{ missing: string[] }>();
    expect(missing).toContain("max_tool_rounds");
    expect(missing).not.toContain("max_sessions");
  });

  it("still answers the routes the admin CLI sets it up with", async () => {
    await clear();
    const settings = await SELF.fetch(`${BASE}/api/admin/settings`, asOwner());
    expect(settings.status).toBe(200);
    expect((await settings.json<{ missing: string[] }>()).missing).toContain("models");
    expect((await SELF.fetch(`${BASE}/api/admin/stats`, asOwner())).status).toBe(200);
  });

  it("serves again once the last field is set", async () => {
    await clear();
    const saved = await patch(SHIPPED);
    expect((await saved.json<{ missing: string[] }>()).missing).toEqual([]);
    const res = await SELF.fetch(
      `${BASE}/api/agents`,
      asOwner({ headers: signedIn("served@x.com") })
    );
    expect(res.status).toBe(200);
  });
});

describe("a setting the owner changed is the one enforced", () => {
  afterEach(async () => {
    await reset();
  });

  it("holds an account to the agent limit the owner set", async () => {
    await patch({ default_agent_limit: 2 });
    const email = `limits-${crypto.randomUUID().slice(0, 8)}@x.com`;
    const create = (name: string) =>
      SELF.fetch(
        `${BASE}/api/agents`,
        asOwner({
          method: "POST",
          headers: signedIn(email),
          body: JSON.stringify({ name, allowed_emails: email }),
        })
      );
    expect((await create("One")).status).toBe(200);
    expect((await create("Two")).status).toBe(200);
    // The third is the one the raised default refuses, where the shipped 1 would have
    // refused the second.
    const third = await create("Three");
    expect(third.status).toBe(403);
    expect((await third.json<{ error: string }>()).error).toMatch(/at most 2 agents/);
  });

  it("refuses a session past the ceiling the owner set, and says that number", async () => {
    await patch({ max_sessions: 1 });
    const email = `sessions-${crypto.randomUUID().slice(0, 8)}@x.com`;
    const created = await SELF.fetch(
      `${BASE}/api/agents`,
      asOwner({
        method: "POST",
        headers: signedIn(email),
        body: JSON.stringify({ name: "Capped", allowed_emails: email }),
      })
    );
    const { id } = await created.json<{ id: string }>();

    const session = () =>
      SELF.fetch(
        `${BASE}/api/agents/${id}/sessions`,
        asOwner({ method: "POST", headers: signedIn(email), body: JSON.stringify({}) })
      );
    expect((await session()).status).toBe(200);
    const refused = await session();
    expect(refused.status).toBe(409);
    expect((await refused.json<{ error: string }>()).error).toBe(sessionLimitMessage(1));
  });

  it("offers the model list the owner typed in", async () => {
    await patch({ models: [{ id: "owner/model", label: "Owner's", vision: false }] });
    const res = await SELF.fetch(
      `${BASE}/api/agents/catalog`,
      asOwner({ headers: signedIn("catalog@x.com") })
    );
    const body = await res.json<{ models: { id: string }[] }>();
    expect(body.models).toEqual([{ id: "owner/model", label: "Owner's", vision: false }]);
  });

  it("offers the MCP templates from the settings, Notion among the shipped ones", async () => {
    expect(SHIPPED.mcp_catalog.map((t) => t.id)).toContain("notion");
    const mine = { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", auth: "oauth" };
    await patch({ mcp_catalog: [mine] });
    const res = await SELF.fetch(
      `${BASE}/api/agents/catalog`,
      asOwner({ headers: signedIn("catalog@x.com") })
    );
    const body = await res.json<{ mcp_catalog: unknown[] }>();
    expect(body.mcp_catalog).toEqual([mine]);
  });

  it("hands the composer the ceilings it has to enforce before it sends", async () => {
    // The browser refuses first, so its number has to be the deployment's number — a
    // page holding its own copy is a limit that drifts from the one that matters.
    await patch({ max_files_per_message: 2, max_upload_bytes: { image: 4_000_000 } });
    const email = `composer-${crypto.randomUUID().slice(0, 8)}@x.com`;
    const created = await SELF.fetch(
      `${BASE}/api/agents`,
      asOwner({
        method: "POST",
        headers: signedIn(email),
        body: JSON.stringify({ name: "Composer", allowed_emails: email }),
      })
    );
    const { id } = await created.json<{ id: string }>();
    const res = await SELF.fetch(
      `${BASE}/api/agents/${id}/config`,
      asOwner({ headers: signedIn(email) })
    );
    const body = await res.json<{
      limits: { max_files_per_message: number; max_upload_bytes: { image: number } };
    }>();
    expect(body.limits.max_files_per_message).toBe(2);
    expect(body.limits.max_upload_bytes.image).toBe(4_000_000);
  });

  it("offers the voice models the owner listed, under the names given", async () => {
    await patch({
      field_options: { voice_model: [{ id: "openai/gpt-audio", label: "Owner's voice" }] },
    });
    const res = await SELF.fetch(
      `${BASE}/api/agents/catalog`,
      asOwner({ headers: signedIn("catalog@x.com") })
    );
    const body = await res.json<{
      capabilities: {
        id: string;
        fields: { key: string; options?: { value: string; label: string }[] }[];
      }[];
    }>();
    const field = body.capabilities.flatMap((c) => c.fields).find((f) => f.key === "voice_model");
    expect(field?.options).toEqual([{ value: "openai/gpt-audio", label: "Owner's voice" }]);
  });

  it("quotes the owner's own upload ceilings in the capability note", async () => {
    // The note is generated, so a deployment that raised a ceiling and still read the
    // shipped figure would be telling its users something nobody could correct.
    await patch({ max_upload_bytes: { pdf: 32_000_000 } });
    const res = await SELF.fetch(
      `${BASE}/api/agents/catalog`,
      asOwner({ headers: signedIn("catalog@x.com") })
    );
    const body = await res.json<{ capabilities: { id: string; note?: string }[] }>();
    const note = body.capabilities.find((c) => c.id === "file_ingest")?.note ?? "";
    expect(note).toContain("32 MB");
  });
});
