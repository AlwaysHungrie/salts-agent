/**
 * Markdown, as models write it, in the HTML subset Telegram renders (`parse_mode: "HTML"`).
 *
 * Telegram's own Markdown modes refuse a whole message over one stray `_` or `*`, which a
 * model writes all the time. HTML only needs `& < >` escaped, so the text around the
 * formatting can never break the send. What Telegram has no tag for degrades: headings
 * become bold lines, list markers become bullets, tables stay as text.
 */

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttr = (text: string) => escape(text).replace(/"/g, "&quot;");

/** A placeholder no model writes, so code is set aside and put back untouched. */
const slot = (i: number) => `\uE000${i}\uE000`;

export function toTelegramHtml(markdown: string): string {
  const kept: string[] = [];
  const keep = (html: string) => slot(kept.push(html) - 1);

  // Code first: nothing inside it is formatting.
  let text = markdown.replace(/```([\w+-]*)[^\S\n]*\n?([\s\S]*?)```/g, (_, lang: string, code: string) =>
    keep(
      lang
        ? `<pre><code class="language-${escapeAttr(lang)}">${escape(code.replace(/\n$/, ""))}</code></pre>`
        : `<pre>${escape(code.replace(/\n$/, ""))}</pre>`
    )
  );
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) => keep(`<code>${escape(code)}</code>`));

  // Links before escaping, so the URL is kept whole; their text is formatted like the rest.
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) =>
    keep(`<a href="${escapeAttr(url)}">`) + label + keep("</a>")
  );

  text = escape(text);

  text = text
    // A heading has no tag of its own; a bold line reads as one.
    .replace(/^#{1,6}[^\S\n]+(.+?)[^\S\n]*#*$/gm, "<b>$1</b>")
    // List markers become bullets, before `*` can be read as emphasis.
    .replace(/^([^\S\n]*)[-*+][^\S\n]+/gm, "$1• ")
    .replace(/\*\*(?!\s)([^\n]+?)\*\*/g, "<b>$1</b>")
    .replace(/__(?!\s)([^\n]+?)__/g, "<b>$1</b>")
    .replace(/~~(?!\s)([^\n]+?)~~/g, "<s>$1</s>")
    .replace(/(^|[^\w*])\*(?![\s*])([^*\n]+?)\*(?!\w)/g, "$1<i>$2</i>")
    // `_` only around whole words: snake_case and file_names stay as they are.
    .replace(/(^|[^\w])_(?![\s_])([^_\n]+?)_(?!\w)/g, "$1<i>$2</i>")
    // Consecutive quoted lines are one quote (`>` is escaped by now).
    .replace(/(^&gt;[^\S\n]?.*(?:\n&gt;[^\S\n]?.*)*)/gm, (block: string) =>
      `<blockquote>${block.replace(/^&gt;[^\S\n]?/gm, "")}</blockquote>`
    );

  return text.replace(/\uE000(\d+)\uE000/g, (_, i: string) => kept[Number(i)]);
}
