import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CAPABILITY_BY_ID,
  capabilityLabels,
  capabilityReady,
  channelLabels,
  enabled,
  runTool,
  SECRET_MASK,
  toolDefinitions,
  toolsFor,
  type ToolContext,
  type ToolSpec,
} from "../src/capabilities";
import { DEFAULT_CONFIG, type Config } from "../src/registry";
import { validateConfig } from "../src/validation/config";
import { SHIPPED } from "./shipped";

/**
 * What the agent is allowed to do on a given turn.
 *
 * `toolsFor` is the gate: a tool the model is never handed is a tool it cannot call,
 * so this is where a capability switch becomes an actual restriction. The cases that
 * matter are the ones where a capability is switched on but not usable — a toggle
 * without its credentials must not produce a tool that fails at call time.
 */

const config = (patch: Partial<Config> = {}): Config => ({
  model: "vendor/model",
  ...SHIPPED.config_defaults,
  ...DEFAULT_CONFIG,
  ...patch,
});

describe("capabilityReady", () => {
  it("is false for a capability that is switched off", () => {
    const capability = CAPABILITY_BY_ID.get("web_search")!;
    expect(capabilityReady(capability, config({ cap_web_search: 0 }))).toBe(false);
  });

  it("is true for a switched-on capability with no required fields", () => {
    const capability = CAPABILITY_BY_ID.get("url_fetch")!;
    expect(capabilityReady(capability, config({ cap_url_fetch: 1 }))).toBe(true);
  });

  it("is false when a required credential is missing", () => {
    const capability = CAPABILITY_BY_ID.get("telegram")!;
    // Switched on but unusable. Offering the tool here would mean a turn that fails
    // inside the model's tool call rather than a capability that is simply off.
    expect(
      capabilityReady(
        capability,
        config({ cap_telegram: 1, telegram_bot_token: "", telegram_bot_username: "" })
      )
    ).toBe(false);
  });

  it("is false when only some required credentials are present", () => {
    const capability = CAPABILITY_BY_ID.get("telegram")!;
    expect(
      capabilityReady(
        capability,
        config({ cap_telegram: 1, telegram_bot_token: "token", telegram_bot_username: "" })
      )
    ).toBe(false);
  });

  it("is true once every required credential is present", () => {
    const capability = CAPABILITY_BY_ID.get("telegram")!;
    expect(
      capabilityReady(
        capability,
        config({ cap_telegram: 1, telegram_bot_token: "t", telegram_bot_username: "bot" })
      )
    ).toBe(true);
  });

  it("treats whitespace as a missing credential", () => {
    const capability = CAPABILITY_BY_ID.get("telegram")!;
    expect(
      capabilityReady(
        capability,
        config({ cap_telegram: 1, telegram_bot_token: "   ", telegram_bot_username: "bot" })
      )
    ).toBe(false);
  });

  it("ignores optional fields", () => {
    const capability = CAPABILITY_BY_ID.get("web_search")!;
    // Brave and SearXNG are both optional; the capability has a fallback either way.
    expect(capabilityReady(capability, config({ cap_web_search: 1, brave_api_key: "" }))).toBe(
      true
    );
  });
});

describe("enabled", () => {
  it("reports a ready capability as on", () => {
    expect(enabled(config({ cap_web_search: 1 }), "web_search")).toBe(true);
  });

  it("reports a switched-off capability as off", () => {
    expect(enabled(config({ cap_web_search: 0 }), "web_search")).toBe(false);
  });

  it("reports an unknown capability as off rather than throwing", () => {
    expect(enabled(config(), "not_a_capability" as never)).toBe(false);
  });
});

describe("toolsFor", () => {
  it("offers nothing on a default config", () => {
    // Every capability ships off. A new agent that could search the web without
    // anyone switching it on would be a surprise, not a convenience.
    const names = toolsFor(config()).map((t) => t.name);
    for (const capability of CAPABILITIES) {
      if (capability.alwaysOn) continue;
      for (const tool of capability.tools) expect(names).not.toContain(tool);
    }
  });

  it("offers a capability's tools once it is on", () => {
    expect(toolsFor(config({ cap_web_search: 1 })).map((t) => t.name)).toContain("web_search");
  });

  it("does not offer tools for a capability missing its credentials", () => {
    const names = toolsFor(config({ cap_telegram: 1 })).map((t) => t.name);
    const telegram = CAPABILITY_BY_ID.get("telegram")!;
    for (const tool of telegram.tools) expect(names).not.toContain(tool);
  });

  it("offers several capabilities' tools together", () => {
    const names = toolsFor(config({ cap_web_search: 1, cap_url_fetch: 1 })).map((t) => t.name);
    expect(names).toContain("web_search");
    expect(names).toContain("fetch_url");
  });

  it("never returns the same tool twice", () => {
    const names = toolsFor(config({ cap_web_search: 1, cap_url_fetch: 1, cap_memory: 1 })).map(
      (t) => t.name
    );
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("toolDefinitions", () => {
  it("shapes each tool the way OpenRouter expects", () => {
    const [definition] = toolDefinitions(config({ cap_url_fetch: 1 })).filter(
      (d) => d.function.name === "fetch_url"
    );
    expect(definition.type).toBe("function");
    expect(definition.function.description).toBeTruthy();
    expect(definition.function.parameters).toBeTruthy();
  });

  it("is empty when nothing is switched on", () => {
    expect(toolDefinitions(config())).toEqual([]);
  });
});

describe("runTool", () => {
  const ctx = {} as ToolContext;

  it("returns a tool's output", async () => {
    const spec: ToolSpec = {
      name: "echo",
      description: "echo",
      parameters: { type: "object", properties: {} },
      run: async (args) => `got ${JSON.stringify(args)}`,
    };
    expect(await runTool("echo", { a: 1 }, ctx, spec)).toEqual({
      content: 'got {"a":1}',
      ok: true,
    });
  });

  it("reports an unknown tool without throwing", async () => {
    const result = await runTool("no_such_tool", {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("no tool named no_such_tool");
  });

  it("turns a thrown error into a message for the model", async () => {
    const spec: ToolSpec = {
      name: "breaks",
      description: "breaks",
      parameters: { type: "object", properties: {} },
      run: async () => {
        throw new Error("upstream is down");
      },
    };
    // Not thrown onward: the model is shown the failure so it can correct itself,
    // and a failed tool must not take the whole turn with it.
    const result = await runTool("breaks", {}, ctx, spec);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("upstream is down");
  });

  it("handles a thrown value that is not an Error", async () => {
    const spec: ToolSpec = {
      name: "throws_string",
      description: "throws a string",
      parameters: { type: "object", properties: {} },
      run: async () => {
        throw "just a string";
      },
    };
    const result = await runTool("throws_string", {}, ctx, spec);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("just a string");
  });
});

describe("the capability catalogue itself", () => {
  it("gives every capability a unique id", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("indexes every capability by id", () => {
    for (const capability of CAPABILITIES) {
      expect(CAPABILITY_BY_ID.get(capability.id)).toBe(capability);
    }
  });

  it("names a config column for every capability flag", () => {
    // A flag with no column is a switch that silently does nothing.
    for (const capability of CAPABILITIES) {
      if (capability.alwaysOn) continue;
      expect(Object.keys(config())).toContain(capability.flag);
    }
  });

  it("names a config column for every credential field", () => {
    for (const field of CAPABILITIES.flatMap((c) => c.fields)) {
      expect(Object.keys(config())).toContain(field.key);
    }
  });

  it("gives a brand-new agent no tools at all", () => {
    // Not every flag ships at 0 — `cap_telegram` and `cap_mcp` default to 1 — so the
    // invariant worth pinning is the one a user would notice: a fresh agent can do
    // nothing until somebody configures it. Telegram is on but not ready without its
    // credentials, and MCP contributes only the tools of servers that were added.
    expect(toolsFor(config())).toEqual([]);
  });

  it("keeps a default-on capability inert until it is configured", () => {
    for (const capability of CAPABILITIES) {
      if (capability.alwaysOn || config()[capability.flag] !== 1) continue;
      const usable = capabilityReady(capability, config()) && capability.tools.length > 0;
      expect(usable).toBe(false);
    }
  });
});

/**
 * What the model is told it has.
 *
 * The bug this guards against is not a crash: with WhatsApp named among the
 * capabilities, the agent offered to send a message to a phone number it was handed,
 * asked for the number, and then reached for bash when no tool turned up. A channel is
 * where a conversation arrived, and the reply goes back the way it came — saying so is
 * the difference between an agent that knows its own reach and one that invents it.
 */

/** A config with WhatsApp switched on and every credential it asks for filled in. */
const withWhatsapp = () =>
  config({
    cap_whatsapp: 1,
    whatsapp_number: "919876543210",
    whatsapp_phone_number_id: "123456789012345",
    whatsapp_waba_id: "123456789012345",
    whatsapp_access_token: "EAAtoken",
    whatsapp_app_secret: "0".repeat(32),
    whatsapp_verify_token: "a phrase only I know",
  });

describe("capabilityLabels", () => {
  it("leaves a channel out, however completely it is configured", () => {
    expect(capabilityLabels(withWhatsapp())).not.toContain("WhatsApp");
  });

  it("keeps a capability that carries no tool but changes what the model is given", () => {
    // Image input hands the model no tool either — it decides what an attachment may
    // become, which is worth knowing and is not a claim about reaching anyone.
    expect(capabilityLabels(config({ cap_vision: 1 }))).toContain("Image input");
  });

  it("keeps naming the capabilities that do carry tools", () => {
    expect(capabilityLabels(config({ cap_memory: 1 }))).toContain("Private Memory");
  });
});

describe("channelLabels", () => {
  it("names a channel that is switched on and configured", () => {
    expect(channelLabels(withWhatsapp())).toEqual(["WhatsApp"]);
  });

  it("names nothing when the switch is on but the credentials are not there", () => {
    expect(channelLabels(config({ cap_whatsapp: 1 }))).toEqual([]);
  });

  it("names nothing when no channel is switched on", () => {
    expect(channelLabels(config())).toEqual([]);
  });

  it("describes every channel the same way", () => {
    // A channel is marked on the capability rather than matched by id, so a third one
    // added later is described correctly without anyone remembering this file.
    const channels = CAPABILITIES.filter((c) => c.channel);
    expect(channels.map((c) => c.id).sort()).toEqual(["telegram", "whatsapp"]);
    expect(channels.every((c) => c.tools.length === 0)).toBe(true);
  });
});

describe("secret credentials in a config patch", () => {
  it("keeps a saved key when the mask comes back", () => {
    expect(validateConfig({ brave_api_key: SECRET_MASK })).not.toHaveProperty("brave_api_key");
  });

  it("clears a saved key when an empty value is sent", () => {
    // The Clear button sends "": that has to reach storage, not be mistaken for "keep".
    expect(validateConfig({ brave_api_key: "" })).toEqual({ brave_api_key: "" });
  });
});
