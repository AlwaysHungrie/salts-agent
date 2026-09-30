import type { ReasoningEffort } from "@/lib/agent";
import type { MetaEditor } from "./metaEditor";
import { inputClass, REASONING, Section } from "./pieces";

/** A range slider with its current value spelled out beside it. */
function Slider({
  min,
  max,
  step,
  value,
  onChange,
  label,
  labelWidth,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  label: string;
  labelWidth: string;
}) {
  return (
    <div className="flex items-center gap-4">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-ink h-1 shrink flex-1 cursor-pointer"
      />
      <span className={`tnum text-muted ${labelWidth} shrink-0 text-right text-sm`}>
        {label}
      </span>
    </div>
  );
}

/** How the agent talks: model, instructions, reasoning, creativity, reply and context size. */
export function TuningSections({ editor }: { editor: MetaEditor }) {
  const { lock, valueOf, setValue, offeredModels } = editor;
  const maxTokens = valueOf("max_tokens");
  const context = valueOf("context_messages");
  return (
    <>
      <Section title="Model" {...lock("model")}>
        <select
          value={valueOf("model") ?? offeredModels[0]?.id ?? ""}
          onChange={(e) => setValue("model", e.target.value)}
          className={`${inputClass} appearance-none`}
        >
          {offeredModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {!m.vision ? " (no image)" : ""}
            </option>
          ))}
        </select>
      </Section>

      <Section
        title="Custom instructions"
        hint="Base instructions given to agent in every chat"
        {...lock("system_prompt")}
      >
        <textarea
          rows={3}
          maxLength={4000}
          value={valueOf("system_prompt") ?? ""}
          onChange={(e) => setValue("system_prompt", e.target.value)}
          placeholder="Answer in short paragraphs. Show code before explaining it."
          className={`${inputClass} resize-y`}
        />
      </Section>

      <Section
        title="Extended reasoning"
        hint="How long the agent thinks before it answers."
        {...lock("reasoning_effort")}
      >
        <select
          value={valueOf("reasoning_effort") ?? "off"}
          onChange={(e) =>
            setValue("reasoning_effort", e.target.value as ReasoningEffort)
          }
          className={`${inputClass} appearance-none`}
        >
          {REASONING.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </Section>

      <Section
        title="Creativity"
        hint="Low keeps answers literal. High makes them varied."
        {...lock("temperature")}
      >
        <Slider
          min={0}
          max={2}
          step={0.1}
          value={valueOf("temperature") ?? 0.7}
          onChange={(v) => setValue("temperature", v)}
          label={(valueOf("temperature") ?? 0.7).toFixed(1)}
          labelWidth="w-16"
        />
      </Section>

      <Section
        title="Reply length cap"
        hint="How long a single reply can run."
        {...lock("max_tokens")}
      >
        <Slider
          min={0}
          max={8000}
          step={250}
          value={maxTokens ?? 0}
          onChange={(v) => setValue("max_tokens", v)}
          label={maxTokens ? `${maxTokens} tokens` : "No cap"}
          labelWidth="w-24"
        />
      </Section>

      <Section
        title="Context window"
        hint="How much of the chat the agent sees each turn."
        {...lock("context_messages")}
      >
        <Slider
          min={0}
          max={100}
          step={2}
          value={context ?? 0}
          onChange={(v) => setValue("context_messages", v)}
          label={context ? `Last ${context}` : "Full history"}
          labelWidth="w-24"
        />
      </Section>
    </>
  );
}
