import type { Env } from "./env";

/** One email from Salts to one person. */
export type OutgoingEmail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

/**
 * Send an email through Cloudflare Email Service (`send_email` binding `EMAIL`), from
 * `EMAIL_FROM`. Throws a short reason when sending is not set up or is refused.
 */
export async function sendEmail(env: Env, email: OutgoingEmail): Promise<void> {
  const from = env.EMAIL_FROM?.trim();
  if (!env.EMAIL || !from) throw new Error("email sending is not set up on this deployment");
  try {
    await env.EMAIL.send({ from: { email: from, name: "Salts" }, ...email });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    console.error(`email to ${email.to} refused: ${String(code ?? "")} ${String(err)}`);
    throw new Error(
      typeof code === "string" ? `email refused: ${code}` : "email could not be sent"
    );
  }
}
