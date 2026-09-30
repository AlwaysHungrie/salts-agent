"use client";

import { useActionState } from "react";
import { create } from "../actions";
import { field, primary } from "@/components/ui";

export function NewForm() {
  const [state, action, pending] = useActionState(create, { error: "" });
  return (
    <form action={action} className="mt-6 space-y-3">
      <input name="name" required autoFocus maxLength={60} placeholder="Salt Branding Advocate" aria-label="Name" className={field} />
      <p className="text-muted px-1 text-sm leading-[1.43]">
        Next you add the notes, the key and who may take it on.
      </p>
      {state.error && <p className="px-1 text-sm text-red-600">{state.error}</p>}
      <button type="submit" disabled={pending} className={primary}>
        {pending ? "Creating…" : "Create challenge"}
      </button>
    </form>
  );
}
