import { mcpServerReady, withMcpAuth } from "../capabilities";
import { sendEmail } from "../email";
import type { McpServerRow } from "../mcp";
import type { SessionHost } from "./types";

/**
 * Orders that spend the user's money are placed by Salts, never by the model. The model
 * can only ask for one: Salts holds it, emails the account owner a one-time code with
 * the order's details, and places the order itself when that code is typed into the
 * chat. The code is checked before any turn, so the model never sees it and cannot
 * approve an order on the user's behalf.
 */

/** How long an emailed code works, and how many wrong tries end it. */
export const ORDER_CODE_TTL_MS = 10 * 60_000;
export const ORDER_CODE_ATTEMPTS = 5;

/** A message that is only a 6-digit code (spaces allowed around it). */
const CODE_MESSAGE = /^\s*(\d{6})\s*$/;

/** The tool that reads the cart an order tool would check out. */
const CART_TOOL: Record<string, string> = {
  place_food_order: "get_food_cart",
  checkout: "get_cart",
};

/** The most cart text an email carries. */
const CART_TEXT_LIMIT = 4000;

type HeldOrder = {
  key: string;
  server_id: string;
  tool: string;
  args: string;
  code_hash: string;
  expires_at: number;
  attempts: number;
};

/** A uniformly random 6-digit code. */
export function newCode(): string {
  const buf = new Uint32Array(1);
  // Rejection sampling: 2^32 is not a multiple of 10^6, so the top values would skew it.
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

/** The stored form of a code: bound to the order, so a code for one order fits no other. */
export async function codeHash(code: string, key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${key}\n${code}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `alex@gmail.com` → `a***@gmail.com`: enough for the user to know where to look. */
export function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  return domain ? `${name.slice(0, 1)}***@${domain}` : "your email";
}

function held(host: SessionHost): HeldOrder | undefined {
  return host.exec<HeldOrder>(`SELECT * FROM order_codes WHERE id = 1`)[0];
}

const drop = (host: SessionHost) => host.exec(`DELETE FROM order_codes WHERE id = 1`);

/** The cart as Swiggy reports it, for the email. Never the model's account of it. */
async function cartText(host: SessionHost, server: McpServerRow, tool: string): Promise<string> {
  const cartTool = CART_TOOL[tool];
  if (!cartTool) return "";
  try {
    const result = await withMcpAuth(server, host.registry(), (client) =>
      client.callTool(cartTool, {})
    );
    const text = result.text.trim();
    return text.length > CART_TEXT_LIMIT ? `${text.slice(0, CART_TEXT_LIMIT)}\n[…]` : text;
  } catch {
    return "";
  }
}

/**
 * Hold an order the model asked for and email its code. Returns what the model is told.
 * The same order asked for again while its code is live sends no second email.
 */
export async function holdOrder(
  host: SessionHost,
  server: McpServerRow,
  tool: string,
  args: Record<string, unknown>,
  key: string,
  name: string
): Promise<string> {
  const notPlaced = `Order NOT placed, and you cannot place it.`;
  const owner = await host.ownerEmail();
  if (!owner) {
    return `${notPlaced} This agent has no owner account to send an order code to, so Salts cannot take orders here.`;
  }
  const waiting = held(host);
  if (waiting && waiting.key === key && waiting.expires_at > Date.now()) {
    return (
      `${notPlaced} The code for this order was already emailed to ${maskEmail(owner)}. ` +
      `Tell the user to type that 6-digit code in this chat; Salts checks it and places the ` +
      `order. Do not call ${name} again.`
    );
  }

  const code = newCode();
  const cart = await cartText(host, server, tool);
  const details = [
    cart ? `The order, as ${server.name} reports it:\n\n${cart}` : "",
    `Sent to ${server.name}:\n${JSON.stringify(args, null, 2)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  host.exec(
    `INSERT OR REPLACE INTO order_codes
       (id, key, server_id, tool, args, code_hash, expires_at, attempts, ts)
     VALUES (1, ?, ?, ?, ?, ?, ?, 0, ?)`,
    key,
    server.id,
    tool,
    JSON.stringify(args),
    await codeHash(code, key),
    Date.now() + ORDER_CODE_TTL_MS,
    Date.now()
  );
  try {
    await sendEmail(host.env, {
      to: owner,
      subject: `${code} is your Salts order code`,
      text:
        `Your Salts agent wants to place an order on ${server.name}.\n\n` +
        `To place it, type this code in your chat with the agent:\n\n    ${code}\n\n` +
        `The code works once, for this order only, for ${ORDER_CODE_TTL_MS / 60_000} minutes. ` +
        `If you did not ask for this order, ignore this email and nothing will be ordered.\n\n` +
        `${details}\n`,
    });
  } catch (err) {
    drop(host);
    const why = err instanceof Error ? err.message : String(err);
    return `${notPlaced} Salts could not email the order code (${why}). Tell the user the order was not placed.`;
  }
  return (
    `${notPlaced} Salts emailed a 6-digit code with this order's details to the account ` +
    `owner at ${maskEmail(owner)}. Tell the user to check that email and type the code in ` +
    `this chat: Salts checks it and places the order itself. Show them what is being ` +
    `ordered if you have not. Do not ask for the code any other way, and do not call ` +
    `${name} again unless the order changes.`
  );
}

/** What a message did to a held order. */
export type CodeOutcome =
  /** Not a code, or no order is waiting: the message is an ordinary one. */
  | { kind: "none" }
  /** Answered by Salts alone (wrong, expired, failed); no turn runs. */
  | { kind: "reply"; text: string }
  /** Placed. `note` replaces the user's message in the turn, so the agent can carry on. */
  | { kind: "placed"; note: string; result: string };

/**
 * Check a user message against the held order before any turn sees it. Only a message
 * that is exactly a 6-digit code, while an order is held, is taken; anything else is
 * left for the turn.
 */
export async function orderCode(host: SessionHost, message: string): Promise<CodeOutcome> {
  const code = message.match(CODE_MESSAGE)?.[1];
  if (!code) return { kind: "none" };
  const order = held(host);
  if (!order) return { kind: "none" };

  if (order.expires_at <= Date.now()) {
    drop(host);
    return {
      kind: "reply",
      text: "That order code has expired, so nothing was ordered. Ask the agent to place the order again for a new code.",
    };
  }
  if ((await codeHash(code, order.key)) !== order.code_hash) {
    const attempts = order.attempts + 1;
    if (attempts >= ORDER_CODE_ATTEMPTS) {
      drop(host);
      return {
        kind: "reply",
        text: "Too many wrong codes, so that order was cancelled and nothing was ordered. Ask the agent to place it again for a new code.",
      };
    }
    host.exec(`UPDATE order_codes SET attempts = ? WHERE id = 1`, attempts);
    return {
      kind: "reply",
      text: `That code is not right. Check the latest Salts email and try again (${ORDER_CODE_ATTEMPTS - attempts} tries left).`,
    };
  }

  // Used up before the call: an order is never sent twice on one code, even if the call
  // fails midway and the user types the code again.
  drop(host);
  const server = await host.registry().mcpServer(order.server_id);
  if (!server || !mcpServerReady(server)) {
    return {
      kind: "reply",
      text: "The code is right, but that app is no longer connected, so nothing was ordered.",
    };
  }
  // Off by default: the whole flow runs, but nothing is sent to the provider.
  if ((await host.settingsNow()).swiggy_live_orders !== 1) {
    return {
      kind: "placed",
      result: `Test mode: the code was right, but live orders are off here, so nothing was sent to ${server.name} and nothing was ordered.`,
      note:
        `[Salts] The user confirmed the order with the emailed code. Live orders are off on ` +
        `this deployment (test mode), so Salts did NOT send it to ${server.name}: nothing was ` +
        `ordered or charged. Tell the user the order was confirmed in test mode and that no ` +
        `real order was placed.`,
    };
  }
  try {
    const result = await withMcpAuth(server, host.registry(), (client) =>
      client.callTool(order.tool, JSON.parse(order.args) as Record<string, unknown>)
    );
    const said = result.text.trim() || "(no details returned)";
    return {
      kind: "placed",
      result: `Order sent to ${server.name}. ${server.name} said:\n\n${said}`,
      note:
        `[Salts] The user confirmed the order with the emailed code, and Salts sent it to ` +
        `${server.name} (${order.tool}). ${server.name} replied:\n\n${said}\n\n` +
        `Tell the user what happened in plain words. If it is waiting on payment, say so ` +
        `rather than calling it placed.`,
    };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      kind: "reply",
      text:
        `The code is right, but ${server.name} did not confirm the order (${why}). It may or ` +
        `may not have gone through: check your orders in the ${server.name} app before ` +
        `trying again.`,
    };
  }
}
