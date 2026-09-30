import { ChipList } from "@/components/CapabilitySection";
import type { CapabilityField, ReasoningEffort } from "@/lib/agent";
import { Lock, LockOpen } from "lucide-react";

export const inputClass =
  "bg-field placeholder:text-faint text-ink w-full rounded-2xl px-4 py-3 text-sm outline-none";

export const REASONING: ReasoningEffort[] = ["off", "low", "medium", "high"];

/** The OpenRouter key, described the way a capability describes its own fields. */
export const OPENROUTER_KEY: CapabilityField = {
  key: "openrouter_api_key",
  label: "OpenRouter API key",
  hint: "Every model call this agent makes is billed to this key.",
  secret: true,
  required: false,
  placeholder: "sk-or-v1-…",
};

/* --------------------------------------------------------------- pieces -- */

/**
 * A titled form block with an optional lock; a locked setting disappears from the
 * agent's own pages.
 */
export function Section({
  title,
  hint,
  lockKey,
  locked,
  onLock,
  children,
}: {
  title: string;
  hint?: string;
  /** The config column or capability id this section governs, if it governs one. */
  lockKey?: string;
  locked?: boolean;
  onLock?: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-hairline-soft border-t py-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-base font-semibold leading-[1.38]">{title}</p>
          {hint && (
            <p className="text-muted mt-1 text-xs font-light leading-[1.33]">
              {hint}
            </p>
          )}
        </div>
        {lockKey && onLock && (
          <LockButton locked={!!locked} onChange={onLock} what={title} />
        )}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

export function LockButton({
  locked,
  onChange,
  what,
}: {
  locked: boolean;
  onChange: (v: boolean) => void;
  what: string;
}) {
  return (
    <button
      onClick={() => onChange(!locked)}
      title={locked ? `Unlock ${what}` : `Lock ${what}`}
      aria-label={locked ? `Unlock ${what}` : `Lock ${what}`}
      aria-pressed={locked}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition ${
        locked
          ? "bg-ink text-on-primary"
          : "text-muted hover:bg-canvas-soft hover:text-ink"
      }`}
    >
      {locked ? (
        <Lock size={14} strokeWidth={2} />
      ) : (
        <LockOpen size={14} strokeWidth={2} />
      )}
    </button>
  );
}

/**
 * A typed list of model ids over `ChipList` (newline-joined), with the deployment's ids
 * as one-click suggestions.
 */
export function IdList({
  label,
  hint,
  value,
  onChange,
  placeholder,
  suggestions,
  suggestionsHint,
  emptyNote,
}: {
  label?: string;
  hint?: string;
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  suggestions: { id: string; label: string }[];
  suggestionsHint?: string;
  emptyNote?: string;
}) {
  const missing = suggestions.filter((s) => !value.includes(s.id));
  return (
    <div>
      <ChipList
        label={label}
        hint={hint}
        placeholder={placeholder}
        value={value.join("\n")}
        onChange={(next) =>
          onChange(
            next
              .split("\n")
              .map((id) => id.trim())
              .filter((id) => id !== ""),
          )
        }
        suggestionHint={suggestionsHint}
        emptyNote={emptyNote}
      />
      {missing.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {missing.map((s) => (
            <button
              key={s.id}
              onClick={() => onChange([...value, s.id])}
              title={s.id}
              className="border-hairline text-muted hover:border-ink hover:text-ink rounded-full border px-3 py-1 text-xs transition"
            >
              + {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
