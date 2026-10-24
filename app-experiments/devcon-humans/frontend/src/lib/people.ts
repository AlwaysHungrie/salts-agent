/** find-humans' answers, as its HTTP API sends them. Shared by the server and the pages. */

export type Entry = { entry_id: string; kind: "text" | "link"; value: string; added: string };

/** A saved profile. */
export type Person = {
  person_id: string;
  name: string | null;
  headline: string;
  location: string | null;
  skills: string[];
  summary: string;
  beliefs: string[];
  links: string[];
  about: string[];
  saved_at: string;
};

/** The user's own entries, and their saved profile (null until first saved). */
export type MyProfile = {
  info: { person_id: string; entries: Entry[]; saved_at: string | null; unsaved_changes: boolean };
  profile: Person | null;
};

/** People the agent names in a reply, linked as `[Name](humans:<person_id>)`, in order, each once. */
export function citedPeople(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(/\]\(humans:([0-9a-f]{32})\)/g)].map((m) => m[1]))];
}

/** A link as people read it: host and path, no scheme or `www.`. */
export function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    return (u.host + u.pathname).replace(/^www\./, "").replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** Where a profile stands: saved and searchable, told the agent things but never saved, or nothing yet. */
export function profileState(p: MyProfile | null): "ACTIVE" | "INCOMPLETE" | "NOT ADDED" {
  if (p?.profile) return "ACTIVE";
  return p?.info.entries.length ? "INCOMPLETE" : "NOT ADDED";
}

/** Beliefs as one quoted line: each starting with a capital, no closing full stop. */
export function quoteBeliefs(beliefs: string[]): string {
  return beliefs.map((b) => `“${b.charAt(0).toUpperCase()}${b.slice(1).replace(/\.$/, "")}”`).join(" · ");
}
