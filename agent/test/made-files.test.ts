import { describe, expect, it } from "vitest";
import { showMadeFiles } from "../src/session/attachments";
import type { SessionHost } from "../src/session/types";

/**
 * Which tool-made files get hung on the reply. A tool that redraws a table three times in
 * one turn makes three pictures; when the reply links the one it settled on, the drafts
 * must not pile up above it.
 */
function host(made: { id: string; kind: string }[]) {
  const hung: string[] = [];
  const fake = {
    turn: { made: made.map((m) => m.id) },
    exec: (sql: string, ...args: unknown[]) => {
      if (sql.startsWith("SELECT * FROM attachments")) return made.filter((m) => m.id === args[0]);
      if (sql.includes("INSERT OR REPLACE INTO message_files")) hung.push(args[1] as string);
      return [];
    },
  } as unknown as SessionHost;
  return { fake, hung };
}

const link = (id: string) => `![Image](/agents/session-agent/s/files/${id})`;

describe("showMadeFiles", () => {
  it("hangs nothing extra when the reply links the picture it chose, but keeps unlinked files", () => {
    const { fake, hung } = host([
      { id: "try-1", kind: "image" },
      { id: "try-2", kind: "image" },
      { id: "checks", kind: "image" },
      { id: "final", kind: "image" },
      { id: "book", kind: "sheet" },
    ]);
    showMadeFiles(fake, "reply", `Here it is:\n${link("final")}`);
    expect(hung).toEqual(["book"]);
  });

  it("hangs every picture when the reply links none, so a forgetful reply still shows them", () => {
    const { fake, hung } = host([
      { id: "a", kind: "image" },
      { id: "b", kind: "image" },
    ]);
    showMadeFiles(fake, "reply", "Section 4 is in the draft.");
    expect(hung).toEqual(["a", "b"]);
  });

  it("shows as many pictures as the reply links", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `img-${i}`);
    const { fake, hung } = host(ids.map((id) => ({ id, kind: "image" })));
    showMadeFiles(fake, "reply", ids.map(link).join("\n"));
    expect(hung).toEqual([]); // all twelve are in the reply itself
  });
});
