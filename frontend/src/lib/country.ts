/**
 * Whether the buyer is in India, so card checkout charges rupees. Vercel reads the
 * country from the caller's IP; off Vercel (local dev) there is no header, and
 * `DEV_COUNTRY` in `.env.local` stands in for it. Neither: dollars.
 */
export function buyerInIndia(request: Request): boolean {
  const country =
    request.headers.get("x-vercel-ip-country") ?? process.env.DEV_COUNTRY;
  return country?.toUpperCase() === "IN";
}
