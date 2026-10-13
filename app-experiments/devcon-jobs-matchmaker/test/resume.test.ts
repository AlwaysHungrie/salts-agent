import { describe, expect, it } from "vitest";
import { withoutId } from "@/lib/resume";

const id = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

describe("withoutId", () => {
  it("drops the field line naming the id", () => {
    const reply = `Added:\n\n**Candidate ID:** \`${id}\`\n**Name:** Dhairya Shah\n\nDone.`;
    expect(withoutId(reply, id)).toBe("Added:\n\n**Name:** Dhairya Shah\n\nDone.");
  });

  it("drops the table row naming the id", () => {
    const reply = `| Field | Value |\n|---|---|\n| Candidate ID | ${id.toUpperCase()} |\n| Name | Dhairya Shah |`;
    expect(withoutId(reply, id)).toBe("| Field | Value |\n|---|---|\n| Name | Dhairya Shah |");
  });

  it("leaves a reply without the id alone", () => {
    expect(withoutId("**Name:** Dhairya Shah", id)).toBe("**Name:** Dhairya Shah");
  });
});
