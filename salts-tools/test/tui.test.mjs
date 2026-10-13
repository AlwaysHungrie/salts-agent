import assert from "node:assert/strict";
import { test } from "node:test";

import { follow, keys, pad, paint, rowText, wrap } from "../tui.mjs";

const plain = (s) => s.replace(/\x1b\[\d+m/g, "");

test("keys keeps escape sequences whole and splits the rest", () => {
  assert.deepEqual(keys("ab\x1b[A\x1b[Zq"), ["a", "b", "\x1b[A", "\x1b[Z", "q"]);
  assert.deepEqual(keys("\x1b"), ["\x1b"]);
});

test("pad truncates with an ellipsis and pads short text", () => {
  assert.equal(pad("abcdef", 4), "abc…");
  assert.equal(pad("ab", 4), "ab  ");
  assert.equal(pad("ab", 0), "");
});

test("rowText fills the width exactly, the last column taking the rest", () => {
  const row = rowText(["web", "live", "https://x.trycloudflare.com/web"], [["", 6], ["", 8], ["", 0]], 40);
  assert.equal(row.length, 40);
  assert.equal(row, "web    live     https://x.trycloudflare…");
});

test("rowText never runs past the width, however wide the columns", () => {
  const row = rowText(["a-very-long-agent-id", "connected"], [["", 30], ["", 0]], 12);
  assert.equal(plain(row).length, 12);
});

test("a toned cell is coloured without changing its width", () => {
  const row = rowText(["web", { text: "live", tone: "good" }], [["", 6], ["", 0]], 20);
  assert.equal(plain(row), "web    live".padEnd(20));
  assert.ok(row.includes(paint("live".padEnd(13), "good")));
  // A reset of its own, so the inverted selection row stays inverted after it.
  assert.ok(!row.includes("\x1b[0m"));
});

test("follow scrolls a row at a time and clamps the selection", () => {
  const pos = { sel: 0, top: 0 };
  pos.sel = 5;
  follow(pos, 10, 3);
  assert.deepEqual(pos, { sel: 5, top: 3 });
  pos.sel = 2;
  follow(pos, 10, 3);
  assert.deepEqual(pos, { sel: 2, top: 2 });
  pos.sel = 99;
  follow(pos, 4, 3);
  assert.deepEqual(pos, { sel: 3, top: 1 });
});

test("wrap breaks at spaces and cuts the last line", () => {
  assert.deepEqual(wrap("short", 20), ["short"]);
  assert.deepEqual(wrap("one two three four", 9), ["one two", "three fo…"]);
  assert.deepEqual(wrap("one two three", 9, 3), ["one two", "three"]);
  assert.deepEqual(wrap("", 9), []);
});
