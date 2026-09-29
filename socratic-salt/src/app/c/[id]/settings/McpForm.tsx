"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/actions";
import { field, secondary } from "@/components/ui";

export function McpForm({ action }: { action: (prev: FormState, form: FormData) => Promise<FormState> }) {
  const [state, submit, pending] = useActionState(action, { error: "" });
  return (
    <form action={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
        <input name="name" required placeholder="Name" aria-label="Server name" className={field} />
        <input name="url" required type="url" placeholder="https://example.com/mcp" aria-label="Server URL" className={field} />
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
        <input name="header_name" placeholder="Header (optional)" aria-label="Header name" className={field} />
        <input name="header_value" type="password" placeholder="Header value, e.g. Bearer …" aria-label="Header value" className={field} />
      </div>
      <div className="flex items-center gap-4">
        <button type="submit" disabled={pending} className={secondary}>
          {pending ? "Connecting…" : "Add server"}
        </button>
        {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      </div>
    </form>
  );
}
