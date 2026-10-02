"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import {
  capabilityReady,
  SECRET_MASK,
  type Capability,
  type CapabilityField,
  type Config,
} from "@/lib/agent";

export function Toggle({
  on,
  disabled = false,
  onChange,
}: {
  on: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition ${
        on ? "bg-ink" : "bg-field"
      } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
    >
      <span
        className={`bg-canvas absolute top-1 h-5 w-5 rounded-full shadow-sm transition-all ${
          on ? "left-6" : "left-1"
        }`}
      />
    </button>
  );
}

/**
 * A list field: one entry per line in the value, a set of chips on screen. Entries
 * are typed in and committed with Enter, so a whitelist is built one name at a time
 * rather than as a block of text to get the separators right in.
 *
 * Exported because the access list on the settings page is the same editor: a set of
 * addresses, one of which — the signed-in user's own — is fixed rather than editable.
 */
export function ChipList({
  label,
  hint,
  suggestionHint,
  placeholder,
  value,
  onChange,
  bordered = false,
  locked = [],
  emptyNote,
}: {
  label?: string;
  hint?: string;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
  bordered?: boolean;
  /** Chips that are always shown and cannot be removed, and are not part of `value`. */
  locked?: string[];
  /** Shown under an otherwise empty list. */
  emptyNote?: string;
  /** Hint text shown under the input, always. */
  suggestionHint?: string;
}) {
  const [draft, setDraft] = useState("");
  const entries = value
    .split("\n")
    .map((e) => e.trim())
    .filter((e) => e !== "");

  const add = (raw: string) => {
    const entry = raw.trim();
    // A duplicate is a no-op rather than an error: nothing about the list changes.
    if (!entry || entries.includes(entry) || locked.includes(entry)) {
      setDraft("");
      return;
    }
    onChange([...entries, entry].join("\n"));
    setDraft("");
  };

  const chip = `text-ink flex items-center gap-2 rounded-full py-1.5 text-[13px] leading-[1.35] ${
    bordered ? "bg-canvas border-hairline border" : "bg-field"
  }`;

  return (
    <div>
      {label && (
        <span className="block text-sm font-semibold leading-[1.43]">
          {label}
        </span>
      )}
      {hint && (
        <span className="text-muted block text-xs font-light leading-[1.33]">
          {hint}
        </span>
      )}

      {(entries.length > 0 || locked.length > 0) && (
        <div className={`flex flex-wrap gap-2 ${label || hint ? "mt-3" : ""}`}>
          {locked.map((entry) => (
            <span
              key={entry}
              className={`${chip} px-3`}
              title="This is your account"
            >
              <span className="max-w-[220px] truncate">{entry}</span>
              <span className="text-faint text-[11px]">You</span>
            </span>
          ))}
          {entries.map((entry) => (
            <span key={entry} className={`${chip} pr-2 pl-3`}>
              <span className="max-w-[220px] truncate">{entry}</span>
              <button
                onClick={() =>
                  onChange(entries.filter((e) => e !== entry).join("\n"))
                }
                aria-label={`Remove ${entry}`}
                className="text-muted hover:text-ink flex h-5 w-5 items-center justify-center rounded-full"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <input
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => add(draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            }
            if (e.key === "Escape") setDraft("");
          }}
          aria-label={label}
          className={`placeholder:text-faint min-w-0 flex-1 rounded-2xl px-4 py-3 text-sm outline-none ${
            bordered ? "bg-canvas border-hairline border" : "bg-field"
          }`}
        />
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => add(draft)}
          disabled={draft.trim() === ""}
          className="bg-canvas border-hairline text-ink hover:bg-canvas-soft shrink-0 rounded-2xl border px-5 text-sm font-semibold transition disabled:opacity-40"
        >
          Add
        </button>
      </div>

      {suggestionHint && (
        <p
          className={`mt-2 text-xs leading-[1.33] ${bordered ? "text-muted" : "text-faint"}`}
        >
          {suggestionHint}
        </p>
      )}

      {entries.length === 0 && emptyNote && (
        <p
          className={`mt-2 text-xs leading-[1.33] ${bordered ? "text-muted" : "text-faint"}`}
        >
          {emptyNote}
        </p>
      )}
    </div>
  );
}

export function Field({
  field,
  value,
  onChange,
  bordered = false,
}: {
  field: CapabilityField;
  value: string;
  /** Commit a new value. Called when the field is left, not on every keystroke. */
  onChange: (v: string) => void;
  /** Outline the inputs, for a section drawn on a tint rather than on the canvas. */
  bordered?: boolean;
}) {
  // The field holds its own text while it is being typed into. Saving is what
  // reloads the config, and a saved secret reads back as the mask — so a
  // save-per-keystroke would replace the half-typed token with dots. Committing on
  // blur keeps what is on screen the thing the user typed.
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  // Whether the field was typed into since it was focused. Clearing a secret and a
  // secret left untouched both read as an empty draft on blur, so only this tells
  // "delete the key" apart from "keep the one already saved".
  const [edited, setEdited] = useState(false);
  // Sync draft to an incoming value while unfocused, without an effect: track the
  // last value seen and adjust draft during render when it changes.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    if (!focused) setDraft(value);
  }

  // A stored secret arrives masked. Focusing clears it, so typing replaces the key
  // and leaving it alone keeps the one already saved.
  const masked = field.secret && draft === SECRET_MASK;

  const commit = (next: string) => {
    setDraft(next);
    if (next !== value) onChange(next);
  };

  // A list is a set of entries, not a line of text, so it has an editor of its own.
  if (field.list)
    return (
      <ChipList
        label={field.label}
        hint={field.hint}
        placeholder={field.placeholder}
        value={value}
        onChange={onChange}
        bordered={bordered}
      />
    );

  return (
    <label className="block">
      <span className="block text-sm font-semibold leading-[1.43]">
        {field.label}
      </span>
      <span className="text-muted block text-xs font-light leading-[1.33]">
        {field.hint}
      </span>
      {field.options ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`text-ink mt-2 w-full appearance-none rounded-2xl px-4 py-3 text-sm outline-none ${
            bordered ? "bg-canvas border-hairline border" : "bg-field"
          }`}
        >
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <div className="mt-2 flex gap-2">
          <input
            type={field.secret && !masked ? "password" : "text"}
            value={draft}
            placeholder={field.placeholder}
            onChange={(e) => {
              setEdited(true);
              setDraft(e.target.value);
            }}
            onFocus={() => {
              setFocused(true);
              setEdited(false);
              if (masked) setDraft("");
            }}
            onBlur={() => {
              setFocused(false);
              // An untouched secret is left alone: the mask means "keep the key".
              // One the user emptied on purpose is cleared.
              if (field.secret && draft === "" && !edited) {
                setDraft(value);
                return;
              }
              commit(draft.trim());
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setEdited(false);
                setDraft(value);
                e.currentTarget.blur();
              }
            }}
            className={`placeholder:text-faint min-w-0 flex-1 rounded-2xl px-4 py-3 text-sm outline-none ${
              bordered ? "bg-canvas border-hairline border" : "bg-field"
            }`}
          />
          {/* Focusing a saved secret empties the box, so there is nothing to delete:
            clearing the stored key needs its own control. */}
          {field.secret && value === SECRET_MASK && !focused && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                commit("");
              }}
              className="bg-canvas border-hairline text-ink hover:bg-canvas-soft shrink-0 rounded-2xl border px-5 text-sm font-semibold transition"
            >
              Clear
            </button>
          )}
        </div>
      )}
    </label>
  );
}

/**
 * One capability: its switch, and the credentials it needs once it is on. Shared by
 * the capabilities page and by Settings, which shows Telegram at the top because
 * connecting the bot is setup, not a tool the agent calls.
 */
export function CapabilitySection({
  capability,
  agentId,
  config,
  set,
  blocked = false,
  blockedNote,
  tint,
  children,
}: {
  capability: Capability;
  /**
   * Which agent is being configured. A guide that explains a callback URL has to
   * name the agent it belongs to, or the reader pastes another agent's route into
   * someone else's dashboard and the handshake is refused.
   */
  agentId?: string;
  config: Config;
  set: (patch: Partial<Config>, wait?: number) => void;
  /** The switch is dead: something else has to change before this can be used. */
  blocked?: boolean;
  blockedNote?: React.ReactNode;
  /**
   * Wash the section in a brand colour, the way a Telegram chat is marked — Telegram
   * blue for the bot, ember for MCP. A tinted section sits on a tint rather than on
   * the canvas, so its inputs are outlined to stay legible.
   */
  tint?: string;
  /**
   * An editor of the capability's own, shown under its fields. Some capabilities are
   * configured by more than a list of values — MCP is a set of servers, not settings.
   */
  children?: React.ReactNode;
}) {
  // A capability marked alwaysOn has no switch: its own configuration is what
  // decides whether it does anything.
  const on = capability.alwaysOn || !!config[capability.flag];
  const ready = capabilityReady(capability, config);
  return (
    <section
      style={
        // The gradient's colour is per-section, so it is a variable Tailwind reads
        // rather than a class it would have to know every brand up front.
        tint ? ({ "--tint": tint } as React.CSSProperties) : undefined
      }
      className={`${
        tint
          ? "mb-2 rounded-3xl bg-linear-to-b from-(--tint)/18 to-transparent px-5 py-6"
          : "border-hairline-soft border-t py-7"
      } ${blocked ? "opacity-50" : ""}`}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-[1.38]">
            {capability.label}
            {blocked && (
              <span className="text-faint ml-2 text-xs font-normal">
                Unavailable
              </span>
            )}
          </h2>
          <p className="text-muted mt-1 text-sm font-light leading-[1.43]">
            {capability.summary}
          </p>
        </div>
        {!capability.alwaysOn && (
          <Toggle
            on={on && !blocked}
            disabled={blocked}
            onChange={(v) => set({ [capability.flag]: v ? 1 : 0 })}
          />
        )}
      </div>

      {blocked && blockedNote && (
        <p className="text-muted mt-4 text-xs leading-[1.33]">{blockedNote}</p>
      )}

      {on && !blocked && (
        <div className="mt-5 space-y-5">
          {capability.guide && (
            // A new tab, not this one: the credentials being collected are pasted
            // into the fields below, and navigating away would lose what is typed.
            <a
              href={
                agentId
                  ? `${capability.guide.href}?agent=${encodeURIComponent(agentId)}`
                  : capability.guide.href
              }
              target="_blank"
              rel="noreferrer"
              className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold leading-[1.33] transition ${
                tint
                  ? "bg-canvas border-hairline hover:bg-canvas-soft border"
                  : "bg-canvas-soft hover:bg-field"
              }`}
            >
              {capability.guide.label}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          )}

          {capability.fields.map((field) => (
            <Field
              key={String(field.key)}
              field={field}
              value={String(config[field.key] ?? "")}
              onChange={(v) => set({ [field.key]: v })}
              bordered={!!tint}
            />
          ))}

          {children}

          {capability.note && (
            <p
              className={`text-xs leading-[1.33] ${tint ? "text-muted" : "text-faint"}`}
            >
              {capability.note}
            </p>
          )}

          {!ready && capability.fields.length > 0 && (
            <p
              className={`rounded-2xl px-4 py-3 text-xs leading-[1.33] ${
                tint ? "bg-canvas border-hairline border" : "bg-canvas-soft"
              }`}
            >
              Fill in the fields above to start using this feature.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** Kept next to the sections that render it, so both pages agree on the wording. */
export function visionBlockedNote(modelLabel: string, agentId: string) {
  return (
    <>
      {modelLabel} can&rsquo;t see images. Pick a model that can in{" "}
      <Link
        href={`/a/${encodeURIComponent(agentId)}/settings`}
        className="text-ink underline"
      >
        Settings
      </Link>
      .
    </>
  );
}
