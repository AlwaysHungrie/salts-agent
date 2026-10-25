import type { SpendState } from "@/lib/agent";
import type { MetaEditor } from "./metaEditor";
import { ModelList } from "./ModelList";
import { IdList, inputClass, Section } from "./pieces";

const SLUG_HINT =
  "Enter any OpenRouter model ID. Leave the list empty to offer the default models.";

/** The administrator's ceilings: monthly and daily spend, and how far the access list may grow. */
export function LimitsSection({
  editor,
  spend,
}: {
  editor: MetaEditor;
  spend?: SpendState | null;
}) {
  const { meta, patch } = editor;
  return (
    <Section
      title="Limits"
      hint="Control how much each agent can spend. This matters most when agents share your OpenRouter key."
    >
      <label className="block">
        <span className="block text-sm font-semibold leading-[1.43]">
          Monthly spend limit
        </span>
        <span className="text-muted block text-xs font-light leading-[1.33]">
          In US dollars, per calendar month. Leave as 0 for no limit.
          {spend ? ` Spent so far this month: $${spend.usd.toFixed(2)}.` : ""}
        </span>
        <input
          type="number"
          min={0}
          step="0.01"
          value={meta.monthly_spend_limit || ""}
          onChange={(e) =>
            patch({ monthly_spend_limit: Number(e.target.value) || 0 })
          }
          placeholder="0"
          className={`${inputClass} mt-2`}
        />
      </label>

      <label className="mt-4 block">
        <span className="block text-sm font-semibold leading-[1.43]">
          Daily spend limit
        </span>
        <span className="text-muted block text-xs font-light leading-[1.33]">
          In US dollars, per day (resets at midnight UTC). Leave as 0 for no limit.
          {spend ? ` Spent so far today: $${spend.day_usd.toFixed(2)}.` : ""}
        </span>
        <input
          type="number"
          min={0}
          step="0.01"
          value={meta.daily_spend_limit || ""}
          onChange={(e) =>
            patch({ daily_spend_limit: Number(e.target.value) || 0 })
          }
          placeholder="0"
          className={`${inputClass} mt-2`}
        />
      </label>

      <label className="mt-4 block">
        <span className="block text-sm font-semibold leading-[1.43]">
          Member limit
        </span>
        <span className="text-muted block text-xs font-light leading-[1.33]">
          How many people can be added to this agent. Leave as 0 for no
          limit.
        </span>
        <input
          type="number"
          min={0}
          step={1}
          value={meta.member_limit || ""}
          onChange={(e) =>
            patch({
              member_limit: Math.max(0, Math.trunc(Number(e.target.value) || 0)),
            })
          }
          placeholder="0"
          className={`${inputClass} mt-2`}
        />
      </label>
    </Section>
  );
}

/** Which models may be offered, and the widened menus for fixed-choice fields. */
export function ModelOptionSections({
  editor,
  catalog,
}: {
  editor: MetaEditor;
  catalog: Parameters<typeof ModelList>[0]["catalog"];
}) {
  const { meta, patch, choiceFields, setFieldOptions } = editor;
  return (
    <>
      <Section title="Model options" hint={SLUG_HINT}>
        <ModelList
          value={meta.models}
          onChange={(models) => patch({ models })}
          catalog={catalog}
        />
      </Section>

      {choiceFields.map((field) => (
        <Section
          key={String(field.key)}
          title={`${field.label} options`}
          hint={SLUG_HINT}
        >
          <IdList
            value={meta.field_options[String(field.key)] ?? []}
            onChange={(next) => setFieldOptions(field, next)}
            placeholder={field.options?.[0]?.value}
            suggestions={(field.options ?? []).map((o) => ({
              id: o.value,
              label: o.label,
            }))}
            suggestionsHint="Default options"
          />
        </Section>
      ))}
    </>
  );
}
