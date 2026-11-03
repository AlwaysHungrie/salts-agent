export type Verdict = { bottle: boolean; extraMl: number };

const PROMPT = `Two photos of a 1 litre water bottle. Photo A is the earlier one, photo B the later one.
B should hold more water than A. Estimate how many extra millilitres B holds, judging by the water level.
Usually the difference is a few ml to a few tens of ml. If the levels look nearly the same, be optimistic and assume a small amount (about 5 ml) was added.
If either photo does not show a water bottle, set bottle to false.
Reply with JSON only: {"bottle": boolean, "extra_ml": number}`;

/** Parse the model's reply; anything unusable counts as no bottle. */
export function parseVerdict(text: string): Verdict {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { bottle: false, extraMl: 0 };
  try {
    const raw = JSON.parse(match[0]) as { bottle?: unknown; extra_ml?: unknown };
    const ml = Number(raw.extra_ml);
    if (raw.bottle !== true || !Number.isFinite(ml)) return { bottle: false, extraMl: 0 };
    // A bottle that is there always gets the optimistic floor, and no more than the bottle holds.
    return { bottle: true, extraMl: Math.min(Math.max(ml, 1), 1000) };
  } catch {
    return { bottle: false, extraMl: 0 };
  }
}

const dataUrl = (bytes: Buffer) => `data:image/jpeg;base64,${bytes.toString("base64")}`;

export async function compare(a: Buffer, b: Buffer): Promise<Verdict> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url: dataUrl(a) } },
            { type: "image_url", image_url: { url: dataUrl(b) } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return parseVerdict(data.choices?.[0]?.message?.content ?? "");
}
