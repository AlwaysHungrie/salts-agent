import { searchIndex } from "@/lib/guide-search";

/**
 * The guide's search index, as one static file: built once, fetched once when the
 * search dialog is first opened, and cached by the browser for every page after that.
 */
export const dynamic = "force-static";

export function GET() {
  return Response.json(searchIndex(), {
    headers: { "cache-control": "public, max-age=0, must-revalidate" },
  });
}
