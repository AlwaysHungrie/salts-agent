"use client";

import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { SALTS_SETUP_PROMPT } from "@/lib/salts";

/**
 * The ⓘ beside the salts-tools line: a dialog holding one prompt to copy into the
 * user's own assistant, which then walks them through the setup on their computer.
 */
export function SaltsToolsInfo() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  const copy = async () => {
    await navigator.clipboard.writeText(SALTS_SETUP_PROMPT);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="How to set up salts-tools"
        className="text-muted hover:text-ink ml-1 inline-flex translate-y-[2px] items-center transition-colors"
      >
        <Info size={14} strokeWidth={2} />
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-5"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-canvas flex max-h-[85vh] w-full max-w-lg flex-col rounded-[20px] px-6 py-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-base font-semibold leading-[1.38]">
              Set up salts-tools with your assistant
            </p>
            <p className="text-muted mt-2 text-sm font-light leading-[1.43]">
              Copy this prompt into Claude, ChatGPT, Grok or any assistant you
              use. It will walk you through installing what salts-tools needs
              and starting it on your computer.
            </p>
            <pre className="bg-canvas-soft text-ink mt-4 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-2xl px-4 py-3 text-xs leading-[1.5]">
              {SALTS_SETUP_PROMPT}
            </pre>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="border-hairline text-ink hover:bg-canvas-soft h-10 rounded-full border px-5 text-sm font-semibold transition"
              >
                Close
              </button>
              <button
                onClick={() => void copy()}
                className="bg-ink text-on-primary h-10 rounded-full px-5 text-sm font-semibold transition hover:opacity-85"
              >
                {copied ? "Copied" : "Copy prompt"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
