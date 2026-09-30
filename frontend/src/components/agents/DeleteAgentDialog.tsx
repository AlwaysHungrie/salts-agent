import type { AgentRow } from "@/lib/agent";
import { useEffect, useRef, useState } from "react";

/**
 * Typing the name out is the only guard between a click and something
 * unrecoverable: chats, files, memories, settings, MCP connections, a Telegram
 * bot that stops answering. Matched exactly, case included, so it takes reading
 * the name rather than pattern-matching a few letters.
 */
export function DeleteAgentDialog({
  agent,
  onCancel,
  onConfirm,
}: {
  agent: AgentRow;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const matches = typed === agent.name;

  useEffect(() => {
    field.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-5">
      <div className="bg-canvas w-full max-w-sm rounded-[20px] px-6 py-6 shadow-xl">
        <p className="text-base font-semibold leading-[1.38]">
          Delete {agent.name}?
        </p>
        <p className="text-muted mt-2 text-sm font-light leading-[1.43]">
          All chats, files, memories, settings and MCP connections will also be
          deleted and the Telegram bot will stop answering.
          <br />
          <br />
          This action cannot be undone. Proceed with caution.
        </p>
        <label className="mt-4 block">
          <span className="text-muted block text-xs leading-[1.33]">
            Type <span className="text-ink font-semibold">{agent.name}</span> to
            confirm
          </span>
          <input
            ref={field}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches) onConfirm();
              if (e.key === "Escape") onCancel();
            }}
            className="bg-field placeholder:text-faint mt-2 w-full rounded-2xl px-4 py-3 text-sm outline-none"
          />
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="border-hairline text-ink hover:bg-canvas-soft h-10 rounded-full border px-5 text-sm font-semibold transition"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!matches}
            className="bg-ink text-on-primary h-10 rounded-full px-5 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
