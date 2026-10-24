import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/**
 * `breaks` renders single line breaks as breaks, for text written one field per line. A link
 * to `humans:<person_id>` names a person the page shows as a result: it becomes a jump to
 * `#person-<person_id>`.
 */
export function Markdown({
  children,
  breaks = false,
  className = "",
}: {
  children: string;
  breaks?: boolean;
  className?: string;
}) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown
        remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
        urlTransform={(url) => (url.startsWith("humans:") ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children }) =>
            href?.startsWith("humans:") ? (
              <a href={`#person-${href.slice(7)}`} className="person-ref">
                {/* Linked by its own id rather than a name: say where it goes instead. */}
                {String(children).startsWith("humans:") ? "see result" : children}
              </a>
            ) : (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
