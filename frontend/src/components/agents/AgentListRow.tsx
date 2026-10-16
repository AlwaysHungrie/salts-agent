import type { AgentRow } from "@/lib/agent";
import { Settings } from "lucide-react";
import Link from "next/link";

/**
 * One agent row, on the page or inside an open fleet. A user gets a link; an admin who is
 * not on the access list gets plain text, since the agent page would refuse them.
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
   * The line under the name: to a member, the fleet or "your own" plus any other members;
   * to an administrator, the members, which are what tell a fleet's agents apart.
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
    <div className="bg-canvas-soft hover:bg-canvas-soft/60 group relative flex items-center gap-3 rounded-2xl px-5 py-4 transition">
      {isUser ? (
        // Stretched over the whole row, so its padding and gaps open the agent too.
        <Link
          href={`/a/${encodeURIComponent(agent.id)}`}
          className="min-w-0 flex-1 after:absolute after:inset-0 after:rounded-2xl"
        >
          {title}
        </Link>
      ) : (
        <div className="min-w-0 flex-1">{title}</div>
      )}
      {/* Admin settings: here, and on the agent's settings page when the admin is also a member. */}
      {showMeta && isAdmin && (
        <button
          onClick={() => onMeta(agent)}
          className="text-muted hover:text-ink relative z-10 shrink-0 text-sm transition"
        >
          <Settings size={16} />
        </button>
      )}
      {isAdmin && (
        <button
          onClick={() => onDelete(agent)}
          aria-label={`Delete ${agent.name}`}
          className="text-muted hover:bg-canvas hover:text-ink relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-base leading-none opacity-100 transition md:opacity-0 md:group-hover:opacity-100"
        >
          ×
        </button>
      )}
    </div>
  );
}
