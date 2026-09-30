import { describe, expect, it } from "vitest";
import { latestStance, stanceOf } from "@/lib/stance";

const standing = `**Partly conceded.** Focus matters.

**Where we stand**
- Agreed: the team is small
- Open: whether the cap holds
- Recommendation: keep Salt, capped. Unchanged.`;

describe("stance", () => {
  it("reads the running tally", () => {
    expect(stanceOf(standing)).toEqual({
      concluded: false,
      body: "- Agreed: the team is small\n- Open: whether the cap holds",
      summary: "keep Salt, capped. Unchanged.",
    });
  });

  it("reads a conclusion with the decision in its heading", () => {
    const s = stanceOf("Enough.\n\n**Conclusion: Keep Salt as its own brand.**\n\nWhat changed:\n- the audience");
    expect(s).toMatchObject({ concluded: true, summary: "Keep Salt as its own brand." });
    expect(s?.body).toBe("What changed:\n- the audience");
  });

  it("reads a conclusion with the decision after the heading", () => {
    expect(stanceOf("**Conclusion**: Rename it Spark.\n\nWhy: the founders decided.")).toMatchObject({
      concluded: true,
      summary: "Rename it Spark.",
    });
    expect(stanceOf("**Conclusion**\n\nFold it into Bonfires.\nBecause.")).toMatchObject({
      summary: "Fold it into Bonfires.",
      body: "Because.",
    });
  });

  it("takes the latest reply that has one", () => {
    expect(latestStance([standing, "A reply cut short."])?.summary).toBe("keep Salt, capped. Unchanged.");
    expect(latestStance(["nothing here"])).toBeNull();
  });
});
