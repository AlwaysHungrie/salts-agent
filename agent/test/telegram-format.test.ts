import { describe, expect, it } from "vitest";
import { toTelegramHtml } from "../src/telegram-format";

describe("Markdown as Telegram HTML", () => {
  it("formats what models write", () => {
    expect(toTelegramHtml("**Short answer:** it *depends* ~~not~~")).toBe(
      "<b>Short answer:</b> it <i>depends</i> <s>not</s>"
    );
    expect(toTelegramHtml("## Setup\n- one\n- two")).toBe("<b>Setup</b>\n• one\n• two");
    expect(toTelegramHtml("> quoted\n> twice")).toBe("<blockquote>quoted\ntwice</blockquote>");
  });

  it("turns links into links, their text formatted too", () => {
    expect(toTelegramHtml("[Video **29:40**](https://youtu.be/Z0SlvakLAQI?t=1780)")).toBe(
      '<a href="https://youtu.be/Z0SlvakLAQI?t=1780">Video <b>29:40</b></a>'
    );
  });

  it("leaves code alone", () => {
    expect(toTelegramHtml("`get_client` and `**x**`")).toBe(
      "<code>get_client</code> and <code>**x**</code>"
    );
    expect(toTelegramHtml("```python\nif a < b:\n    print(a)\n```")).toBe(
      '<pre><code class="language-python">if a &lt; b:\n    print(a)</code></pre>'
    );
  });

  it("escapes what HTML would read, and keeps words with underscores whole", () => {
    expect(toTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
    expect(toTelegramHtml("concepts_1.mdx and snake_case_name")).toBe(
      "concepts_1.mdx and snake_case_name"
    );
    expect(toTelegramHtml("2 * 3 * 4")).toBe("2 * 3 * 4");
  });
});
