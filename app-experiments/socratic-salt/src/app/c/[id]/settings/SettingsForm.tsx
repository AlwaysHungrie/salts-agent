"use client";

import { useActionState, useState } from "react";
import { Upload } from "lucide-react";
import type { FormState } from "@/app/actions";
import type { ChallengeSettings } from "@/lib/challenges";
import { card, field, hint, label, primary } from "@/components/ui";

type Props = {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  settings: ChallengeSettings;
  models: { id: string; label: string }[];
};

export function SettingsForm({ action, settings, models }: Props) {
  const [state, submit, pending] = useActionState(action, { error: "" });
  const [guestsOn, setGuestsOn] = useState(settings.guests.enabled);
  const options = models.some((m) => m.id === settings.model)
    ? models
    : [{ id: settings.model, label: settings.model }, ...models];
  const saved = (secret: string, placeholder: string) => (secret ? "Saved — leave blank to keep" : placeholder);

  return (
    <form action={submit} className="mt-6 space-y-4">
      <section className={card}>
        <SectionHead title="Challenge" />
        <Field name="name" title="Name" defaultValue={settings.name} maxLength={60} required />
        <Notes
          name="public_notes"
          title="Public notes"
          help="What challengers read beside the chat. The agent is told it too."
          defaultValue={settings.public_notes}
        />
        <Notes
          name="private_notes"
          title="Private notes"
          help="The agent's brief: its position, evidence and rules. Only the model sees it."
          defaultValue={settings.private_notes}
        />
      </section>

      <section className={card}>
        <SectionHead title="Who can take it on" />
        <Toggle
          name="guests"
          title="Open to challengers"
          checked={guestsOn}
          onChange={setGuestsOn}
          help="Off: only you can message it."
        />
        {guestsOn && (
          <div>
            <label className={label} htmlFor="guest_emails">Email whitelist</label>
            <textarea
              id="guest_emails"
              name="guest_emails"
              rows={4}
              defaultValue={settings.guests.emails.join("\n")}
              placeholder={"alice@example.com\nbob@example.com"}
              className={`${field} mt-2 text-[15px]`}
            />
            <p className={hint}>One per line. Empty lets anyone who is signed in take it on.</p>
          </div>
        )}
        {!guestsOn && <input type="hidden" name="guest_emails" value={settings.guests.emails.join("\n")} />}
      </section>

      <section className={card}>
        <SectionHead title="Model" />
        <Field
          name="openrouter_api_key"
          title="OpenRouter API key"
          type="password"
          placeholder={saved(settings.openrouter_api_key, "sk-or-…")}
          help="Every challenger's messages are billed to this key."
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="model">Model</label>
            <select id="model" name="model" defaultValue={settings.model} className={`${field} mt-2`}>
              {options.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
          <Field
            name="max_tokens"
            title="Max reply tokens"
            type="number"
            min={0}
            defaultValue={String(settings.max_tokens)}
            help="0 lets the model decide."
          />
        </div>
        <Field
          name="monthly_spend_limit"
          title="Monthly spend limit (USD)"
          type="number"
          min={0}
          step="0.01"
          defaultValue={String(settings.monthly_spend_limit)}
          help="The agent stops answering once this month's spend reaches it. 0 means no limit."
        />
      </section>

      <section className={card}>
        <SectionHead title="Tools" />
        <Toggle name="web_search" title="Web search" defaultChecked={!!settings.cap_web_search} />
        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            name="searxng_url"
            title="SearXNG URL"
            type="url"
            defaultValue={settings.searxng_url}
            placeholder="https://searxng.example.com"
          />
          <Field
            name="searxng_token"
            title="SearXNG token"
            type="password"
            placeholder={saved(settings.searxng_token, "If the instance is guarded")}
          />
        </div>
        <Field
          name="brave_api_key"
          title="Brave Search API key"
          type="password"
          placeholder={saved(settings.brave_api_key, "BSA…")}
          help="Used instead of SearXNG when set."
        />
        <Toggle name="url_fetch" title="Open URLs" defaultChecked={!!settings.cap_url_fetch} />
      </section>

      <div className="flex items-center gap-4 pt-2">
        <button type="submit" disabled={pending} className={primary}>
          {pending ? "Saving…" : "Save"}
        </button>
        {state.error ? (
          <p className="text-sm text-red-600">{state.error}</p>
        ) : (
          state.saved && !pending && <p className="text-muted text-sm">Saved.</p>
        )}
      </div>
    </form>
  );
}

function SectionHead({ title }: { title: string }) {
  return <h2 className="text-xl leading-[1.3] font-[650]">{title}</h2>;
}

function Field({
  name,
  title,
  help,
  ...rest
}: { name: string; title: string; help?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label className={label} htmlFor={name}>{title}</label>
      <input id={name} name={name} autoComplete="off" className={`${field} mt-2`} {...rest} />
      {help && <p className={hint}>{help}</p>}
    </div>
  );
}

function Toggle({
  name,
  title,
  help,
  defaultChecked,
  checked,
  onChange,
}: {
  name: string;
  title: string;
  help?: string;
  defaultChecked?: boolean;
  checked?: boolean;
  onChange?: (on: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="block text-base font-semibold">{title}</span>
        {help && <span className={hint}>{help}</span>}
      </span>
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        checked={checked}
        onChange={onChange ? (e) => onChange(e.target.checked) : undefined}
        className="peer sr-only"
      />
      <span className="bg-hairline peer-checked:bg-ink relative mt-0.5 h-7 w-12 shrink-0 rounded-full transition after:absolute after:top-1 after:left-1 after:size-5 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-5" />
    </label>
  );
}

/** A markdown note: typed, pasted, or loaded from a .md file. */
function Notes({ name, title, help, defaultValue }: { name: string; title: string; help: string; defaultValue: string }) {
  const [value, setValue] = useState(defaultValue);
  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <label className={label} htmlFor={name}>{title}</label>
          <p className={hint}>{help}</p>
        </div>
        <label className="border-hairline text-ink hover:bg-canvas-soft inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition">
          <Upload className="size-3.5" /> Load .md
          <input
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) setValue(await file.text());
              e.target.value = "";
            }}
          />
        </label>
      </div>
      <textarea
        id={name}
        name={name}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={10}
        className={`${field} mt-2 font-mono text-[13px] leading-[1.5]`}
      />
      <p className={`${hint} text-right`}>{value.length.toLocaleString()} / 64,000</p>
    </div>
  );
}
