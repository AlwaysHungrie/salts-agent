import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpToolSpecs, orderKey, placesOrder, type ToolContext } from "../src/capabilities";
import { fetchHonouringRateLimit, retryAfterMs, type McpServerRow } from "../src/mcp";
import { EMPTY_MCP_SERVER } from "../src/registry";
import {
  holdOrder,
  maskEmail,
  newCode,
  ORDER_CODE_ATTEMPTS,
  orderCode,
} from "../src/session/orders";
import type { SessionHost } from "../src/session/types";

/**
 * Swiggy's production asks of an agent that orders for people: no order without the
 * user's explicit yes, and 429s waited out for as long as `Retry-After` says.
 *
 * The yes is not the model's to give. An order tool call is held; Salts emails the
 * owner a one-time code and places the order itself when the code is typed in the chat.
 */

const swiggy = (patch: Partial<McpServerRow> = {}): McpServerRow => ({
  ...EMPTY_MCP_SERVER,
  id: "sw1",
  name: "Instamart",
  url: "https://mcp.swiggy.com/im",
  enabled: 1,
  created_at: 0,
  tools_json: JSON.stringify([{ name: "checkout" }, { name: "get_cart" }]),
  ...patch,
});

const rpc = (result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    headers: { "content-type": "application/json" },
  });

/** A fake Swiggy: answers `get_cart` and `checkout`, and records every tool call. */
function stubSwiggy() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params?: { name: string; arguments: Record<string, unknown> };
    };
    if (body.method !== "tools/call") return rpc({});
    calls.push({ name: body.params!.name, args: body.params!.arguments });
    const text =
      body.params!.name === "get_cart" ? "1x Amul Taaza 500ml, total ₹30" : "Order #42 placed";
    return rpc({ content: [{ type: "text", text }] });
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe("placesOrder", () => {
  it("marks Swiggy's order tools on production and staging", () => {
    expect(placesOrder(swiggy(), "checkout")).toBe(true);
    expect(placesOrder(swiggy({ url: "https://mcp.swiggy.com/food" }), "place_food_order")).toBe(
      true
    );
    expect(placesOrder(swiggy({ url: "https://mcp-staging.swiggy.com/im" }), "checkout")).toBe(
      true
    );
  });

  it("leaves other tools and other servers alone", () => {
    expect(placesOrder(swiggy(), "get_cart")).toBe(false);
    expect(placesOrder(swiggy({ url: "https://mcp.example.com/im" }), "checkout")).toBe(false);
    expect(placesOrder(swiggy({ url: "not a url" }), "checkout")).toBe(false);
  });
});

describe("orderKey", () => {
  it("is the same for the same arguments in any key order", () => {
    const s = swiggy();
    expect(orderKey(s, "checkout", { addressId: "a", paymentMethod: "COD" })).toBe(
      orderKey(s, "checkout", { paymentMethod: "COD", addressId: "a" })
    );
  });

  it("differs when anything the order is sent differs", () => {
    const s = swiggy();
    expect(orderKey(s, "checkout", { addressId: "a" })).not.toBe(
      orderKey(s, "checkout", { addressId: "b" })
    );
  });
});

describe("order tools in a turn", () => {
  const ctx = () =>
    ({
      holdOrder: vi.fn(async () => "held"),
      settings: { max_upload_bytes: {} },
      registry: { noteMcpError: vi.fn() },
    }) as unknown as ToolContext;

  it("never reach the server from the model: they are held", async () => {
    const calls = stubSwiggy();
    const c = ctx();
    const checkout = mcpToolSpecs([swiggy()]).find((t) => t.name.endsWith("checkout"))!;
    expect(await checkout.run({ addressId: "a" }, c)).toBe("held");
    expect(c.holdOrder).toHaveBeenCalledWith(expect.objectContaining({ id: "sw1" }), "checkout", {
      addressId: "a",
    });
    expect(calls).toEqual([]);
  });

  it("leave tools that place no order alone", async () => {
    stubSwiggy();
    const c = ctx();
    const cart = mcpToolSpecs([swiggy()]).find((t) => t.name.endsWith("get_cart"))!;
    expect(await cart.run({}, c)).toContain("Amul");
    expect(c.holdOrder).not.toHaveBeenCalled();
  });
});

describe("newCode and maskEmail", () => {
  it("makes 6-digit codes", () => {
    for (let i = 0; i < 50; i++) expect(newCode()).toMatch(/^\d{6}$/);
  });

  it("masks an address down to its first letter and domain", () => {
    expect(maskEmail("alex@gmail.com")).toBe("a***@gmail.com");
    expect(maskEmail("nonsense")).toBe("your email");
  });
});

describe("the emailed order code", () => {
  type Run = {
    host: SessionHost;
    send: ReturnType<typeof vi.fn>;
    /** The code in the latest email. */
    code: () => string;
    hold: (args?: Record<string, unknown>) => Promise<string>;
  };

  /** A real session's SQL, with email, owner and server lookups stood in for. */
  async function inSession(
    fn: (run: Run) => Promise<void>,
    opts: { owner?: string; sendFails?: boolean; live?: boolean } = {}
  ) {
    const stub = env.SessionAgent.get(env.SessionAgent.idFromName(crypto.randomUUID()));
    await runInDurableObject(stub, async (instance) => {
      const real = (instance as unknown as { host: SessionHost }).host;
      real.ensureSchema();
      const send = vi.fn(async () => {
        if (opts.sendFails) throw Object.assign(new Error("nope"), { code: "E_DELIVERY_FAILED" });
        return { messageId: "m1" };
      });
      const server = swiggy();
      const host: SessionHost = {
        ...real,
        env: {
          ...real.env,
          EMAIL: { send } as unknown as SendEmail,
          EMAIL_FROM: "noreply@salts.dev",
        },
        ownerEmail: async () => opts.owner ?? "owner@example.com",
        settingsNow: async () => ({
          ...(await real.settingsNow()),
          swiggy_live_orders: opts.live === false ? 0 : 1,
        }),
        registry: () => ({ mcpServer: async () => server, noteMcpError: async () => {} }) as never,
      };
      const code = () => {
        const calls = send.mock.calls as unknown as [{ subject: string }][];
        return calls.at(-1)![0].subject.slice(0, 6);
      };
      const hold = (args: Record<string, unknown> = { addressId: "home" }) =>
        holdOrder(
          host,
          server,
          "checkout",
          args,
          orderKey(server, "checkout", args),
          "instamart_checkout"
        );
      await fn({ host, send, code, hold });
    });
  }

  it("is emailed to the owner with Swiggy's own cart, and nothing is ordered", () =>
    inSession(async ({ send, hold }) => {
      const calls = stubSwiggy();
      const told = await hold();
      expect(told).toContain("NOT placed");
      expect(told).toContain("o***@example.com");
      expect(send).toHaveBeenCalledTimes(1);
      const email = (send.mock.calls[0] as unknown as [Record<string, string>])[0];
      expect(email.to).toBe("owner@example.com");
      expect(email.subject).toMatch(/^\d{6} is your Salts order code$/);
      expect(email.text).toContain("1x Amul Taaza 500ml, total ₹30");
      expect(calls.map((c) => c.name)).toEqual(["get_cart"]);
    }));

  it("places the order with exactly the held arguments when the right code is typed", () =>
    inSession(async ({ host, code, hold }) => {
      const calls = stubSwiggy();
      await hold({ addressId: "home", paymentMethod: "COD" });
      const outcome = await orderCode(host, ` ${code()} `);
      expect(outcome.kind).toBe("placed");
      expect(outcome.kind === "placed" && outcome.note).toContain("Order #42 placed");
      expect(calls.at(-1)).toEqual({
        name: "checkout",
        args: { addressId: "home", paymentMethod: "COD" },
      });
    }));

  it("orders nothing while live orders are off, though the code is accepted", () =>
    inSession(
      async ({ host, code, hold }) => {
        const calls = stubSwiggy();
        await hold();
        const outcome = await orderCode(host, code());
        expect(outcome.kind).toBe("placed");
        expect(outcome.kind === "placed" && outcome.note).toContain("did NOT send it");
        expect(calls.some((c) => c.name === "checkout")).toBe(false);
        // Used up all the same: the code cannot be replayed once live orders are on.
        expect((await orderCode(host, code())).kind).toBe("none");
      },
      { live: false }
    ));

  it("works once: the same code typed again orders nothing more", () =>
    inSession(async ({ host, code, hold }) => {
      const calls = stubSwiggy();
      await hold();
      const sent = code();
      await orderCode(host, sent);
      expect((await orderCode(host, sent)).kind).toBe("none");
      expect(calls.filter((c) => c.name === "checkout")).toHaveLength(1);
    }));

  it("refuses a wrong code, and cancels the order after too many", () =>
    inSession(async ({ host, code, hold }) => {
      const calls = stubSwiggy();
      await hold();
      const wrong = code() === "000000" ? "111111" : "000000";
      for (let i = 1; i < ORDER_CODE_ATTEMPTS; i++) {
        const outcome = await orderCode(host, wrong);
        expect(outcome).toEqual({ kind: "reply", text: expect.stringContaining("not right") });
      }
      expect(await orderCode(host, wrong)).toEqual({
        kind: "reply",
        text: expect.stringContaining("cancelled"),
      });
      // Even the right code is too late now.
      expect((await orderCode(host, code())).kind).toBe("none");
      expect(calls.some((c) => c.name === "checkout")).toBe(false);
    }));

  it("refuses an expired code", () =>
    inSession(async ({ host, code, hold }) => {
      const calls = stubSwiggy();
      await hold();
      host.exec(`UPDATE order_codes SET expires_at = 0`);
      expect(await orderCode(host, code())).toEqual({
        kind: "reply",
        text: expect.stringContaining("expired"),
      });
      expect(calls.some((c) => c.name === "checkout")).toBe(false);
    }));

  it("does not fit a different order: changing the order makes a new code", () =>
    inSession(async ({ host, send, code, hold }) => {
      stubSwiggy();
      await hold({ addressId: "home" });
      const first = code();
      await hold({ addressId: "office" });
      expect(send).toHaveBeenCalledTimes(2);
      if (first !== code()) {
        expect((await orderCode(host, first)).kind).toBe("reply");
      }
      expect((await orderCode(host, code())).kind).toBe("placed");
    }));

  it("sends no second email when the model asks for the same order again", () =>
    inSession(async ({ send, hold }) => {
      stubSwiggy();
      await hold();
      expect(await hold()).toContain("already emailed");
      expect(send).toHaveBeenCalledTimes(1);
    }));

  it("leaves ordinary messages, and codes with no order waiting, to the turn", () =>
    inSession(async ({ host, hold }) => {
      stubSwiggy();
      expect((await orderCode(host, "123456")).kind).toBe("none");
      await hold();
      expect((await orderCode(host, "yes please")).kind).toBe("none");
      expect((await orderCode(host, "my pin is 1234567")).kind).toBe("none");
    }));

  it("holds nothing when the email cannot be sent", () =>
    inSession(
      async ({ host, hold }) => {
        stubSwiggy();
        expect(await hold()).toContain("could not email");
        expect((await orderCode(host, "123456")).kind).toBe("none");
      },
      { sendFails: true }
    ));

  it("takes no orders for an agent without an owner account", () =>
    inSession(
      async ({ send, hold }) => {
        expect(await hold()).toContain("no owner account");
        expect(send).not.toHaveBeenCalled();
      },
      { owner: "" }
    ));
});

describe("retryAfterMs", () => {
  it("reads seconds and HTTP dates", () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs("Thu, 01 Jan 1970 00:00:10 GMT", 4000)).toBe(6000);
    expect(retryAfterMs("Thu, 01 Jan 1970 00:00:01 GMT", 4000)).toBe(0);
  });

  it("is undefined for a missing or unreadable value", () => {
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("soon")).toBeUndefined();
  });
});

describe("fetchHonouringRateLimit", () => {
  const limited = (after: string) =>
    new Response("slow down", { status: 429, headers: { "retry-after": after } });

  it("resends after a 429 and returns the answer", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(limited("0"))
      .mockResolvedValueOnce(new Response("ok"));
    const res = await fetchHonouringRateLimit("https://mcp.test", { method: "POST", body: "{}" });
    expect(await res.text()).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("gives up at once, naming the wait, when it would run past the budget", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => limited("120"));
    await expect(
      fetchHonouringRateLimit("https://mcp.test", { method: "POST", body: "{}" })
    ).rejects.toThrow("wait 120s");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("stops after five resends", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => limited("0"));
    await expect(
      fetchHonouringRateLimit("https://mcp.test", { method: "POST", body: "{}" })
    ).rejects.toThrow("rate limited");
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });
});
