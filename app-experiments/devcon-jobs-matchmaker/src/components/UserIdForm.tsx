"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { parseUserId } from "@/lib/rules";
import { Badge } from "./Badge";

const LAST_USER = "devcon-jobs:last-user";

/** No sign-in yet: the user writes an id on their badge, remembered in this browser. */
export function UserIdForm() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    try {
      const last = localStorage.getItem(LAST_USER);
      if (last && input.current && !input.current.value)
        input.current.value = last;
    } catch {}
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const id = parseUserId(input.current?.value);
    if (!id) {
      setError(
        "Use up to 64 letters, numbers, dots, dashes, underscores or @.",
      );
      input.current?.focus();
      return;
    }
    try {
      localStorage.setItem(LAST_USER, id);
    } catch {}
    router.push(`/u/${encodeURIComponent(id)}`);
  }

  return (
    <Badge
      strap="h-24 lg:h-40"
      className="badge-swing mx-auto w-full max-w-[360px]"
    >
      <form onSubmit={submit} noValidate>
        <label
          htmlFor="user-id"
          className="font-display text-2xl font-semibold tracking-tight"
        >
          Hello, I&rsquo;m
        </label>
        <input
          ref={input}
          id="user-id"
          onChange={() => setError("")}
          autoFocus
          autoComplete="username"
          spellCheck={false}
          placeholder="your-id"
          aria-describedby="user-id-hint"
          aria-invalid={!!error}
          className="mt-2 w-full border-b-2 border-line bg-transparent pb-2 font-display text-4xl font-bold tracking-tight text-violet outline-none placeholder:text-line focus:border-violet focus-visible:outline-none"
        />
        <p
          id="user-id-hint"
          className={`mt-3 text-sm ${error ? "text-raspberry" : "text-ink-2"}`}
        >
          {error ||
            "Devcon Ticket Required. Inorder to identify you, it will never be stored anywhere."}
        </p>
        <button
          type="submit"
          className="mt-6 w-full rounded-full bg-ink px-5 py-3.5 font-semibold text-white transition-colors hover:bg-violet-deep"
        >
          Pick up my badge
        </button>
      </form>
    </Badge>
  );
}
