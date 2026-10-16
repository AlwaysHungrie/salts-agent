// Bundle the user guide into the Worker: `frontend/content/guide/*.md` → `src/guide.json`.
//
// The guide's markdown is the single source; this copy is generated, never edited, and
// not committed. `npm run dev|typecheck|test` regenerate it first (see package.json), so
// `!docs <page>` and the agent's `run_command docs` always read what the web guide shows.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "..", "..", "frontend", "content", "guide");
const out = path.join(here, "..", "src", "guide.json");

/** Same `key: value` frontmatter `frontend/src/lib/guide.ts` reads. */
function parse(raw) {
  if (!raw.startsWith("---")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: raw };
  const meta = {};
  for (const line of raw.slice(3, end).split("\n")) {
    const at = line.indexOf(":");
    if (at !== -1) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { meta, body: raw.slice(end + 4).replace(/^\n+/, "") };
}

const pages = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith(".md"))
  .sort()
  .map((name) => {
    const { meta, body } = parse(fs.readFileSync(path.join(dir, name), "utf8"));
    const slug = name.replace(/\.md$/, "");
    return {
      slug,
      title: meta.title ?? slug,
      section: meta.section ?? "Get started",
      summary: meta.summary ?? "",
      body,
    };
  });

const json = `${JSON.stringify(pages, null, 2)}\n`;
// Unchanged output is not rewritten, so a watcher does not reload on every run.
if (!fs.existsSync(out) || fs.readFileSync(out, "utf8") !== json) fs.writeFileSync(out, json);
