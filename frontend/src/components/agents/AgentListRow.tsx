import type { AgentRow } from "@/lib/agent";
import { Settings } from "lucide-react";
import Link from "next/link";

/**
 * One agent on the list, wherever it is drawn: on the page itself, or inside an
 * open fleet.
 *
 * Two different things put a row here, and they decide what the row offers. A user
 * opens the agent; an admin administers it. An admin who is not also on the access
 * list gets no door: the name is text, not a link, because the page behind it
 * answers them the same way it answers a stranger.
 */
export function AgentListRow({
  agent,
  email,
  onMeta,
  onDelete,
  showMeta,
}: {
  agent: AgentRow;
  email: string;
  onMeta: (agent: AgentRow) => void;
  onDelete: (agent: AgentRow) => void;
  showMeta?: boolean;
}) {
  const isAdmin = agent.admin_email === email;
  const isUser = agent.allowed_emails
    .split("\n")
    .map((e) => e.trim().toLowerCase())
    .includes(email);
  const members = agent.allowed_emails
    .split("\n")
    .map((e) => e.trim())
    .filter(Boolean);
  /**
   * The line under the name, and it answers a different question depending on who
   * is reading it.
   *
   * To a member, their own address is not information — they know it — so the line
   * says what the agent *is* instead: the fleet it belongs to, or that it is their
   * own. Anyone else on it is still named, because that is the part they do not
   * already know.
   *
   * To an administrator looking down a fleet, the addresses are the whole point:
   * every agent in a fleet has the same name, and the member is the only thing that
   * tells one from the next.
   */
  const others = members.filter((e) => e.toLowerCase() !== email);
  const subtitle = isUser
    ? [
        agent.fleet_name || "Personal agent",
        others.length ? `shared with ${others.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : members.join(", ") || "No members";
  const title = (
    <>
      <span className="block truncate text-base font-semibold leading-[1.38]">
        {agent.name}
      </span>
      <span className="text-faint block truncate text-xs leading-[1.33]">
        {subtitle}
      </span>
    </>
  );

  return (
    <div className="bg-canvas-soft hover:bg-canvas-soft/60 group flex items-center gap-3 rounded-2xl px-5 py-4 transition">
      {isUser ? (
        <Link
          href={`/a/${encodeURIComponent(agent.id)}`}
          className="min-w-0 flex-1"
        >
          {title}
        </Link>
      ) : (
        <div className="min-w-0 flex-1">{title}</div>
      )}
      {/* Admin settings are the defaults behind the agent's own settings, so they
          are reachable only from here — never from the agent's pages, where they
          would read as one more setting. */}
      {showMeta && isAdmin && (
        <button
          onClick={() => onMeta(agent)}
          className="text-muted hover:text-ink shrink-0 text-sm transition"
        >
          <Settings size={16} />
        </button>
      )}
      {isAdmin && (
        <button
          onClick={() => onDelete(agent)}
          aria-label={`Delete ${agent.name}`}
          className="text-muted hover:bg-canvas hover:text-ink flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-base leading-none opacity-100 transition md:opacity-0 md:group-hover:opacity-100"
        >
          ×
        </button>
      )}
    </div>
  );
}
