import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The markdown the guide is written in, rendered to the app's own type scale.
 *
 * Ported from `landing-page/lib/markdown.tsx` and kept just as small: headings,
 * paragraphs, lists, tables, fenced code, blockquotes, rules, and three inline forms —
 * `code`, **bold**, and links. No library, no HTML passthrough, no italics: an
 * underscore in a config key or a star in a shell glob must survive being written down.
 *
 * What the guide needs on top of the docs, because the WhatsApp walkthrough was
 * written as a page before it was a file:
 *
 * - Screenshots: a line that is only `![alt](/path.png)`. A title of `"narrow"` keeps
 *   a tall, thin crop (a sidebar) from being stretched to the full column.
 * - Lists inside lists, and screenshots inside list items: anything indented under an
 *   item belongs to it.
 * - Two kinds of callout: a plain `>` quote, and `> [!warning]` for the bordered one.
 * - Step headings: `## 1. Create a Meta app` draws the number faint, ahead of the title.
 * - Widgets: a line that is only `{{name}}` is replaced by the element the page hands
 *   in under that name — the copyable callback URL, the verify-token generator. An
 *   unknown name renders nothing rather than the braces.
 * - A backslash escapes the character after it, so `\<Your-Name\>` reads the same
 *   here as on GitHub.
 *
 * Nothing here knows where the markdown came from. `guide.ts` reads the files, this
 * turns a string into elements, and the page arranges them.
 */

/* ------------------------------------------------------------- headings -- */

export type Heading = { depth: 2 | 3; text: string; id: string };

/** Heading text -> anchor. "Set a spending limit" becomes "set-a-spending-limit". */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The `##` and `###` headings of a document, in order, for the on-page contents.
 * Fenced code is skipped so a comment starting with `#` never becomes a section.
 */
export function headingsOf(markdown: string): Heading[] {
  const out: Heading[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^(##|###)\s+(.*)$/.exec(line);
    if (match) {
      const text = unescape(match[2].trim());
      out.push({ depth: match[1].length as 2 | 3, text, id: slugify(text) });
    }
  }
  return out;
}

/** `\<` to `<`: the markdown escapes, for text that is shown without being parsed. */
export function unescape(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!<>|])/g, "$1");
}

/* --------------------------------------------------------------- inline -- */

/** `code`, **bold**, [text](href), and a backslash escape. Everything else is left as written. */
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)|\\([\\`*_{}[\]()#+\-.!<>|])/g;

const linkClass =
  "font-medium text-accent underline decoration-accent/30 underline-offset-[3px] transition-colors hover:decoration-accent";

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  const pattern = new RegExp(INLINE.source, "g");

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const key = `${keyPrefix}-${match.index}`;

    if (match[1] !== undefined) {
      nodes.push(
        <code
          key={key}
          className="bg-canvas-soft text-ink rounded-[6px] px-1.5 py-0.5 font-mono text-[0.87em]"
        >
          {match[1]}
        </code>,
      );
    } else if (match[2] !== undefined) {
      nodes.push(
        <strong key={key} className="text-ink font-semibold">
          {inline(match[2], key)}
        </strong>,
      );
    } else if (match[3] !== undefined && match[4] !== undefined) {
      const href = match[4];
      const external = /^https?:\/\//.test(href);
      nodes.push(
        external ? (
          <a key={key} href={href} target="_blank" rel="noreferrer" className={linkClass}>
            {inline(match[3], key)}
          </a>
        ) : (
          <Link key={key} href={href} className={linkClass}>
            {inline(match[3], key)}
          </Link>
        ),
      );
    } else if (match[5] !== undefined) {
      nodes.push(match[5]);
    }
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/* --------------------------------------------------------------- blocks -- */

type Block =
  | { kind: "heading"; depth: 1 | 2 | 3 | 4; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: Block[][] }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "quote"; warning: boolean; blocks: Block[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "image"; alt: string; src: string; narrow: boolean }
  | { kind: "widget"; name: string }
  | { kind: "rule" };

const cells = (row: string): string[] =>
  row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());

const isTableRow = (line: string) => line.trim().startsWith("|");
const isDivider = (line: string) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");

const BULLET = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const IMAGE = /^!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)$/;
const WIDGET = /^\{\{\s*([a-z0-9-]+)\s*\}\}$/;

const indentOf = (line: string) => line.length - line.trimStart().length;

/** Lines to blocks, one pass. Lists and quotes parse their own insides the same way. */
function parse(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      i += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const lang = trimmed.slice(3).trim();
      const indent = indentOf(line);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        body.push(lines[i].slice(Math.min(indent, indentOf(lines[i]))));
        i += 1;
      }
      i += 1; // the closing fence
      blocks.push({ kind: "code", lang, lines: body });
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      blocks.push({
        kind: "heading",
        depth: heading[1].length as 1 | 2 | 3 | 4,
        text: heading[2].trim(),
      });
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      blocks.push({ kind: "rule" });
      i += 1;
      continue;
    }

    const image = IMAGE.exec(trimmed);
    if (image) {
      blocks.push({ kind: "image", alt: image[1], src: image[2], narrow: image[3] === "narrow" });
      i += 1;
      continue;
    }

    const widget = WIDGET.exec(trimmed);
    if (widget) {
      blocks.push({ kind: "widget", name: widget[1] });
      i += 1;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isDivider(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(cells(lines[i]));
        i += 1;
      }
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    if (trimmed.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        body.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      const warning = /^\[!warning\]\s*$/i.test(body[0] ?? "");
      blocks.push({ kind: "quote", warning, blocks: parse(body.slice(warning ? 1 : 0).join("\n")) });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      const indent = bullet[1].length;
      const ordered = /\d/.test(bullet[2]);
      const items: Block[][] = [];

      const sibling = (at: number) => {
        const next = BULLET.exec(lines[at] ?? "");
        return next && next[1].length === indent && /\d/.test(next[2]) === ordered ? next : null;
      };

      while (i < lines.length) {
        // Blank lines between two items keep them in one list: a loose list, which
        // is what an item with a screenshot under it always is.
        if (items.length > 0 && lines[i].trim() === "") {
          let ahead = i;
          while (ahead < lines.length && lines[ahead].trim() === "") ahead += 1;
          if (!sibling(ahead)) break;
          i = ahead;
        }
        const next = sibling(i);
        if (!next) break;

        // The item is its first line plus everything indented under it, blank lines
        // included when more of the item follows them. Dedented by the width of the
        // marker, so a nested list or a screenshot parses as if it stood alone.
        const own: string[] = [next[3]];
        const width = next[1].length + next[2].length + 1;
        i += 1;
        while (i < lines.length) {
          const current = lines[i];
          if (current.trim() === "") {
            let ahead = i + 1;
            while (ahead < lines.length && lines[ahead].trim() === "") ahead += 1;
            if (ahead < lines.length && indentOf(lines[ahead]) > indent) {
              own.push("");
              i += 1;
              continue;
            }
            break;
          }
          if (indentOf(current) <= indent) break;
          own.push(current.slice(Math.min(width, indentOf(current))));
          i += 1;
        }
        items.push(parse(own.join("\n")));
      }

      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trim().startsWith("```") &&
      !/^#{1,4}\s/.test(lines[i].trim()) &&
      !isTableRow(lines[i]) &&
      !lines[i].trim().startsWith(">") &&
      !BULLET.test(lines[i]) &&
      !IMAGE.test(lines[i].trim()) &&
      !WIDGET.test(lines[i].trim())
    ) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }

  return blocks;
}

/* ------------------------------------------------------------- renderer -- */

type Widgets = Record<string, ReactNode>;

/** A parsed document, drawn. Headings carry the ids the contents list links to. */
export function Markdown({ source, widgets = {} }: { source: string; widgets?: Widgets }) {
  return (
    <div className="text-muted text-[16px] leading-[1.65]">
      <Blocks blocks={parse(source)} prefix="b" widgets={widgets} depth={0} />
    </div>
  );
}

function Blocks({
  blocks,
  prefix,
  widgets,
  depth,
}: {
  blocks: Block[];
  prefix: string;
  widgets: Widgets;
  /** How many lists deep this is, so a nested ordered list counts a, b, c. */
  depth: number;
}) {
  return (
    <>
      {blocks.map((block, index) => (
        <BlockView
          key={index}
          block={block}
          id={`${prefix}-${index}`}
          widgets={widgets}
          depth={depth}
        />
      ))}
    </>
  );
}

function BlockView({
  block,
  id,
  widgets,
  depth,
}: {
  block: Block;
  id: string;
  widgets: Widgets;
  depth: number;
}) {
  switch (block.kind) {
    case "heading": {
      const text = unescape(block.text);
      const anchor = slugify(text);
      // "1. Create a Meta app": the number is drawn faint, ahead of the title.
      const step = /^(\d+)\.\s+(.*)$/.exec(block.text);
      const title = step ? (
        <>
          <span className="text-faint mr-2.5 tabular-nums">{step[1]}</span>
          {inline(step[2], id)}
        </>
      ) : (
        inline(block.text, id)
      );
      if (block.depth <= 2) {
        return (
          <h2
            id={anchor}
            className="border-hairline-soft text-ink mt-11 scroll-mt-24 border-t pt-9 text-[24px] leading-[1.2] font-[650] tracking-[-0.02em] first:mt-0 first:border-0 first:pt-0"
          >
            {title}
          </h2>
        );
      }
      if (block.depth === 3) {
        return (
          <h3
            id={anchor}
            className="text-ink mt-8 scroll-mt-24 text-[18px] leading-[1.3] font-[650] tracking-[-0.015em]"
          >
            {title}
          </h3>
        );
      }
      return (
        <h4 id={anchor} className="text-ink mt-7 scroll-mt-24 text-[16px] font-semibold">
          {title}
        </h4>
      );
    }

    case "paragraph":
      return <p className="mt-4 first:mt-0">{inline(block.text, id)}</p>;

    case "list": {
      const items = block.items.map((item, j) => {
        // An item that is one line of text is drawn as that text; anything more is
        // drawn as the blocks it holds, its first paragraph flush with the marker.
        const [first, ...rest] = item;
        return (
          <li key={j} className="pl-1.5">
            {first?.kind === "paragraph" ? (
              <>
                {inline(first.text, `${id}-${j}`)}
                <Blocks blocks={rest} prefix={`${id}-${j}`} widgets={widgets} depth={depth + 1} />
              </>
            ) : (
              <Blocks blocks={item} prefix={`${id}-${j}`} widgets={widgets} depth={depth + 1} />
            )}
          </li>
        );
      });
      return block.ordered ? (
        <ol
          className={`marker:text-faint mt-4 space-y-3 pl-5 marker:text-[14px] ${
            depth > 0 ? "list-[lower-alpha]" : "list-decimal"
          }`}
        >
          {items}
        </ol>
      ) : (
        <ul className="marker:text-faint mt-4 list-disc space-y-2 pl-5">{items}</ul>
      );
    }

    case "code":
      return (
        <pre className="bg-canvas-soft ring-hairline-soft mt-5 overflow-x-auto rounded-[16px] p-4 ring-1">
          <code className="text-ink font-mono text-[13px] leading-[1.6]">
            {block.lines.join("\n")}
          </code>
        </pre>
      );

    case "quote":
      return (
        <div
          className={`mt-5 rounded-[16px] px-5 py-4 text-[15px] ${
            block.warning
              ? "border-hairline bg-canvas text-ink border"
              : "bg-canvas-soft ring-hairline-soft ring-1"
          }`}
        >
          <Blocks blocks={block.blocks} prefix={id} widgets={widgets} depth={depth} />
        </div>
      );

    case "image":
      return (
        // The screenshots are plain files with no dimensions written down anywhere,
        // so there is nothing to hand next/image; the browser sizes them as they load.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={block.src}
          alt={block.alt}
          loading="lazy"
          className={`border-hairline mt-4 block h-auto w-full rounded-xl border ${
            block.narrow ? "max-w-[260px]" : ""
          }`}
        />
      );

    case "widget":
      return <div className="mt-4">{widgets[block.name] ?? null}</div>;

    case "table":
      return <Table head={block.head} rows={block.rows} id={id} />;

    case "rule":
      return <hr className="border-hairline-soft mt-10" />;
  }
}

/**
 * A table, and on a phone the same rows stacked — each cell labelled by its own
 * column heading, because a four-column table at 360px is unreadable.
 */
function Table({ head, rows, id }: { head: string[]; rows: string[][]; id: string }) {
  return (
    <div className="ring-hairline-soft mt-6 overflow-hidden rounded-[16px] ring-1">
      <table className="hidden w-full border-collapse text-left align-top text-[14px] sm:table">
        <thead>
          <tr className="bg-canvas-soft">
            {head.map((cell, i) => (
              <th key={i} className="text-ink px-4 py-3 text-[13px] font-semibold">
                {inline(cell, `${id}-th-${i}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-hairline-soft border-t">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={`px-4 py-3 align-top leading-relaxed ${j === 0 ? "text-ink font-medium" : ""}`}
                >
                  {inline(cell, `${id}-td-${i}-${j}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="sm:hidden">
        {rows.map((row, i) => (
          <div key={i} className="border-hairline-soft border-t px-4 py-4 first:border-0">
            {row.map((cell, j) => (
              <div key={j} className={j > 0 ? "mt-2" : ""}>
                <p className="text-faint text-[11px] font-semibold tracking-[0.06em] uppercase">
                  {unescape(head[j] ?? "")}
                </p>
                <p className="mt-0.5 text-[14px] leading-relaxed">
                  {inline(cell, `${id}-m-${i}-${j}`)}
                </p>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
