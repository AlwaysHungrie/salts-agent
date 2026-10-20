import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/** One way to get a key, as a card: an icon, what it is, and a note under it. */
export function PayOption({
  icon,
  title,
  note,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  note: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="ring-hairline-soft hover:ring-ink flex w-full items-center gap-4 rounded-[24px] p-5 text-left ring-1 transition"
    >
      <span className="bg-ink text-on-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-semibold leading-[1.38]">
          {title}
        </span>
        <span className="text-muted mt-0.5 block text-xs leading-[1.33]">
          {note}
        </span>
      </span>
      <ChevronRight className="text-faint h-4 w-4 shrink-0" />
    </button>
  );
}
