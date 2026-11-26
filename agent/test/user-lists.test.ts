import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_BY_ID,
  capabilityInstructions,
  runTool,
  toolsFor,
  type ToolContext,
} from "../src/capabilities";
import { DEFAULT_CONFIG, type Config, type UserLists } from "../src/registry";
import { SHIPPED } from "./shipped";

/**
 * User lists: one object per account holding named lists of entries, shared by every
 * agent the account owns. These pin the object's rules (names, limits, ids) and that the
 * tools exist only while the capability is on.
 */

const config = (patch: Partial<Config> = {}): Config => ({
  model: "vendor/model",
  ...SHIPPED.config_defaults,
  ...DEFAULT_CONFIG,
  ...patch,
});

const LIMITS = { lists: 2, items: 3, chars: 20 };

const listsOf = (owner = crypto.randomUUID()) => env.UserLists.get(env.UserLists.idFromName(owner));

/**
 * Assert the object refuses a call. Run inside the object, since a refusal crossing RPC
 * is also reported to the pool as an unhandled rejection.
 */
async function refused(
  lists: ReturnType<typeof listsOf>,
  call: (instance: UserLists) => unknown,
  message: string
) {
  await runInDurableObject(lists, (instance: UserLists) => {
    expect(() => call(instance)).toThrow(message);
  });
}

/** A tool context with only what the list tools touch. */
function contextFor(owner: string): ToolContext {
  return {
    config: config({ cap_user_lists: 1 }),
    settings: { ...SHIPPED, max_user_lists: 5, max_list_items: 10, max_list_item_chars: 100 },
    lists: async () => listsOf(owner),
  } as unknown as ToolContext;
}

describe("the UserLists object", () => {
  it("creates, fills, edits and empties a list", async () => {
    const lists = listsOf();
    await lists.create("Shopping", "Things to buy", LIMITS);
    const added = await lists.add("shopping", ["milk", " eggs ", ""], LIMITS);
    expect(added.map((i) => i.text)).toEqual(["milk", "eggs"]);

    await lists.edit("SHOPPING", added[0].id, "oat milk", LIMITS);
    expect(await lists.remove("Shopping", [added[1].id, 999_999])).toBe(1);

    const list = await lists.read("Shopping");
    expect(list.description).toBe("Things to buy");
    expect(list.items.map((i) => i.text)).toEqual(["oat milk"]);
    expect((await lists.index())[0]).toMatchObject({ name: "Shopping", items: 1 });
  });

  it("refuses a second list of the same name, whatever its case", async () => {
    const lists = listsOf();
    await lists.create("Books", "", LIMITS);
    await refused(lists, (o) => o.create("books", "", LIMITS), "already exists");
  });

  it("holds to the list, entry and length limits", async () => {
    const lists = listsOf();
    await lists.create("A", "", LIMITS);
    await lists.create("B", "", LIMITS);
    await refused(lists, (o) => o.create("C", "", LIMITS), "list limit");

    await lists.add("A", ["1", "2"], LIMITS);
    // All or none: two more would pass three, so neither is added.
    await refused(lists, (o) => o.add("A", ["3", "4"], LIMITS), "entry limit");
    expect((await lists.read("A")).items).toHaveLength(2);
    await refused(lists, (o) => o.add("A", ["x".repeat(21)], LIMITS), "20 characters");
  });

  it("deletes a list with its entries, and names a missing one", async () => {
    const lists = listsOf();
    await lists.create("Calls", "", LIMITS);
    await lists.add("Calls", ["Mum"], LIMITS);
    expect(await lists.drop("calls")).toBe("Calls");
    expect(await lists.index()).toEqual([]);
    await refused(lists, (o) => o.read("Calls"), 'there is no list called "Calls"');
  });

  it("keeps each owner's lists apart", async () => {
    await listsOf("one@x.com").create("Mine", "", LIMITS);
    expect(await listsOf("two@x.com").index()).toEqual([]);
  });
});

describe("the list tools", () => {
  it("are offered only while User lists is on", () => {
    const names = (c: Config) => toolsFor(c).map((t) => t.name);
    expect(names(config({ cap_user_lists: 0 }))).not.toContain("add_to_list");
    expect(names(config({ cap_user_lists: 1 }))).toEqual(
      expect.arrayContaining([
        "create_list",
        "read_list",
        "add_to_list",
        "edit_list_item",
        "remove_from_list",
        "delete_list",
      ])
    );
  });

  it("tell the model how to use the lists only while the capability is on", () => {
    const text = CAPABILITY_BY_ID.get("user_lists")!.instructions!;
    expect(capabilityInstructions(config({ cap_user_lists: 0 }))).not.toContain(text);
    expect(capabilityInstructions(config({ cap_user_lists: 1 }))).toContain(text);
  });

  it("run a list from creation to deletion", async () => {
    const ctx = contextFor(crypto.randomUUID());
    const run = async (name: string, args: Record<string, unknown>) =>
      (await runTool(name, args, ctx)).content;

    expect(await run("create_list", { name: "Shopping", description: "To buy" })).toBe(
      'Created the list "Shopping".'
    );
    expect(await run("add_to_list", { name: "Shopping", items: ["milk", "bread"] })).toMatch(
      /#\d+ milk\n#\d+ bread/
    );
    const read = await run("read_list", { name: "shopping" });
    expect(read).toMatch(/^Shopping — To buy\n#\d+ milk\n#\d+ bread$/);
    const milk = Number(read.match(/#(\d+) milk/)![1]);

    expect(await run("edit_list_item", { name: "Shopping", id: milk, text: "oat milk" })).toBe(
      `Changed #${milk} to: oat milk`
    );
    expect(await run("remove_from_list", { name: "Shopping", ids: [milk] })).toBe(
      "Removed 1 entry."
    );
    expect(await run("delete_list", { name: "Shopping" })).toBe('Deleted the list "Shopping".');
    expect(await run("read_list", { name: "Shopping" })).toContain("there is no list called");
  });
});
