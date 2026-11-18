import { chain } from "@/lib/chain";
import { sendUsdc } from "@/lib/pay";
import { usdcUnits } from "@/lib/pricing";
import { readReference, writeReference } from "@/lib/reference";
import { walletFor } from "@/lib/salts";
import { compare } from "@/lib/vision";

export const maxDuration = 60;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const say = (message: string, status = 200, paid?: { amount: string; txUrl: string }) =>
  Response.json({ message, ...paid }, { status });

export async function POST(request: Request) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const photo = form.get("photo");
  if (!EMAIL.test(email)) return say("Enter a valid email.", 400);
  if (!(photo instanceof File) || !photo.size) return say("Take a picture first.", 400);
  const after = Buffer.from(await photo.arrayBuffer());

  const before = await readReference();
  if (!before) {
    await writeReference(after);
    return say("Ready. Add some water and try again.");
  }

  try {
    const verdict = await compare(before, after);
    if (!verdict.bottle) return say("I couldn't verify you gave me any water.");
    const address = await walletFor(email);
    const units = usdcUnits(verdict.extraMl);
    const hash = await sendUsdc(address, units);
    await writeReference(after);
    return say(
      "Thanks for the water, I paid your agent's wallet directly. You can access it at app.salts.dev",
      200,
      {
        amount: `${Number(units) / 1e6} USDC`,
        txUrl: `${chain.blockExplorers.default.url}/tx/${hash}`,
      }
    );
  } catch (err) {
    console.error(err);
    return say("Something went wrong. Try again.", 500);
  }
}
