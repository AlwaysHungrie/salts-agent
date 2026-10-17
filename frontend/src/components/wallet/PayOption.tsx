import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/** One way to buy credit, as a card: an icon, what it is, and a note under it. */
export function PayOption({
  icon,
  title,
  note,
  onClick,
  soon,
}: {
  icon: ReactNode;
  title: string;
  note: string;
  onClick?: () => void;
  /** Not open yet: the card shows a "Coming soon" tag and can't be pressed. */
  soon?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={soon || !onClick}
      className="ring-hairline-soft hover:ring-ink flex w-full items-center gap-4 rounded-[24px] p-5 text-left ring-1 transition disabled:cursor-not-allowed disabled:hover:ring-hairline-soft"
    >
      <span
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
          soon ? "bg-canvas-soft text-muted" : "bg-ink text-on-primary"
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block text-base font-semibold leading-[1.38] ${soon ? "text-muted" : ""}`}
        >
          {title}
        </span>
        <span className="text-muted mt-0.5 block text-xs leading-[1.33]">
          {note}
        </span>
      </span>
      {soon ? (
        <span className="bg-canvas-soft text-muted shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold">
          Coming soon
        </span>
      ) : (
        <ChevronRight className="text-faint h-4 w-4 shrink-0" />
      )}
    </button>
  );
}
