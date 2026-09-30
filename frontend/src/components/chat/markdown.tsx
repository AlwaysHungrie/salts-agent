

/**
 * Markdown, rendered with an explicit component map rather than a prose plugin, so
 * every element lands on the same monochrome scale as the rest of the app.
 */
export const MARKDOWN_COMPONENTS = (sessionId: string) => ({
  p: (props: React.ComponentProps<"p">) => (
    <p className="my-2 first:mt-0 last:mb-0" {...props} />
  ),
  ul: (props: React.ComponentProps<"ul">) => (
    <ul className="my-2 list-disc space-y-1 pl-5" {...props} />
  ),
  ol: (props: React.ComponentProps<"ol">) => (
    <ol className="my-2 list-decimal space-y-1 pl-5" {...props} />
  ),
  li: (props: React.ComponentProps<"li">) => (
    <li className="leading-normal" {...props} />
  ),
  h1: (props: React.ComponentProps<"h1">) => (
    <h1 className="mt-4 mb-2 text-xl" {...props} />
  ),
  h2: (props: React.ComponentProps<"h2">) => (
    <h2 className="mt-4 mb-2 text-lg" {...props} />
  ),
  h3: (props: React.ComponentProps<"h3">) => (
    <h3 className="mt-3 mb-1 text-base" {...props} />
  ),
  a: (props: React.ComponentProps<"a">) => (
    <a
      className="underline underline-offset-2"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  strong: (props: React.ComponentProps<"strong">) => (
    <strong className="font-semibold" {...props} />
  ),
  hr: () => <hr className="border-hairline-soft my-4" />,
  blockquote: (props: React.ComponentProps<"blockquote">) => (
    <blockquote
      className="border-hairline my-2 border-l-2 pl-4 italic"
      {...props}
    />
  ),
  code: ({ className, ...props }: React.ComponentProps<"code">) =>
    // Fenced code arrives wrapped in <pre>, which carries the block styling; only
    // inline code needs its own chip.
    className?.includes("language-") ? (
      <code className={className} {...props} />
    ) : (
      <code
        className="bg-canvas-soft rounded px-1.5 py-0.5 text-sm"
        {...props}
      />
    ),
  pre: (props: React.ComponentProps<"pre">) => (
    <pre
      className="bg-canvas-soft my-2 overflow-x-auto rounded-2xl px-4 py-3 text-[13px] leading-normal"
      {...props}
    />
  ),
  table: (props: React.ComponentProps<"table">) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...props} />
    </div>
  ),
  th: (props: React.ComponentProps<"th">) => (
    <th
      className="border-hairline-soft border-b px-3 py-2 text-left font-semibold"
      {...props}
    />
  ),
  td: (props: React.ComponentProps<"td">) => (
    <td
      className="border-hairline-soft border-b px-3 py-2 align-top"
      {...props}
    />
  ),
  img: ({ src, alt }: React.ComponentProps<"img">) => (
    // Rewrite the Worker's own image path to the browser's API route.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={String(src ?? "").replace(
        /^\/agents\/session-agent\/[^/]+\/files\//,
        `/api/sessions/${encodeURIComponent(sessionId)}/files/`,
      )}
      alt={alt ?? ""}
      className="border-hairline-soft my-2 block max-w-full rounded-2xl border"
    />
  ),
});
