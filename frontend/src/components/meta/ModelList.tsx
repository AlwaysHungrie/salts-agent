import type { ModelChoice, ModelOption } from "@/lib/agent";
import { useState } from "react";

/**
 * Models an agent may use, each with a "no images" flag that whoever adds it sets.
 * Suggestions are the deployment's models, which bring their own flag.
 */
export function ModelList({
  value,
  onChange,
  catalog,
}: {
  value: ModelChoice[];
  onChange: (value: ModelChoice[]) => void;
  catalog: ModelOption[];
}) {
  const [draft, setDraft] = useState("");
  /** Whether the model being typed is one that cannot be sent an image. */
  const [blind, setBlind] = useState(false);

  const add = (id: string, vision: boolean) => {
    const entry = id.trim();
    // A duplicate is a no-op rather than an error: nothing about the list changes.
    if (entry === "" || value.some((m) => m.id === entry)) return;
    onChange([...value, { id: entry, vision }]);
  };

  const commit = () => {
    add(draft, !blind);
    setDraft("");
    setBlind(false);
  };

  const missing = catalog.filter((m) => !value.some((v) => v.id === m.id));
  const chip =
    "bg-field text-ink flex items-center gap-2 rounded-full py-1.5 pr-2 pl-3 text-[13px] leading-[1.35]";

  return (
    <div>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {value.map((model) => (
            <span key={model.id} className={chip}>
              <span className="max-w-[220px] truncate">{model.id}</span>
              {!model.vision && (
                <span className="text-faint text-[11px]">(no image)</span>
              )}
              <button
                onClick={() => onChange(value.filter((m) => m.id !== model.id))}
                aria-label={`Remove ${model.id}`}
                className="text-muted hover:text-ink flex h-5 w-5 items-center justify-center rounded-full"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className={`flex gap-2 ${value.length > 0 ? "mt-3" : ""}`}>
        <input
          value={draft}
          placeholder="deepseek/deepseek-v4-flash"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") setDraft("");
          }}
          aria-label="OpenRouter model id"
          className="bg-field placeholder:text-faint min-w-0 flex-1 rounded-2xl px-4 py-3 text-sm outline-none"
        />
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={commit}
          disabled={draft.trim() === ""}
          className="bg-canvas border-hairline text-ink hover:bg-canvas-soft shrink-0 rounded-2xl border px-5 text-sm font-semibold transition disabled:opacity-40"
        >
          Add
        </button>
      </div>

      <label className="text-muted mt-2 flex cursor-pointer items-center gap-2 text-xs leading-[1.33]">
        <input
          type="checkbox"
          checked={blind}
          onChange={(e) => setBlind(e.target.checked)}
          className="accent-ink h-3.5 w-3.5 cursor-pointer"
        />
        This model cannot be sent images
      </label>

      {missing.length > 0 && (
        <>
          <p className="text-faint mt-3 text-xs leading-[1.33]">
            Default options
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {missing.map((m) => (
              <button
                key={m.id}
                onClick={() => add(m.id, m.vision)}
                title={m.id}
                className="border-hairline text-muted hover:border-ink hover:text-ink rounded-full border px-3 py-1 text-xs transition"
              >
                + {m.label}
                {!m.vision && " (no image)"}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
