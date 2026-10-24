"use client";

import { forwardRef, useLayoutEffect, useRef } from "react";
import { messageProblem } from "@/lib/rules";

/**
 * Typing straight onto the page: no box, a green caret, the field growing with the text.
 * Enter sends, Shift + Enter breaks the line.
 */
export const TerminalInput = forwardRef<
  HTMLTextAreaElement,
  {
    id: string;
    label: string;
    value: string;
    onChange: (v: string) => void;
    onSubmit: () => void;
    placeholder: string;
    disabled?: boolean;
    className?: string;
    autoFocus?: boolean;
  }
>(function TerminalInput({ id, label, value, onChange, onSubmit, placeholder, disabled, className = "", autoFocus }, ref) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const problem = value.trim() ? messageProblem(value) : null;

  useLayoutEffect(() => {
    const el = own.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <div>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        ref={(el) => {
          own.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        id={id}
        rows={1}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        enterKeyHint="send"
        placeholder={placeholder}
        aria-invalid={!!problem}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!problem && value.trim()) onSubmit();
          }
        }}
        className={`terminal-field overflow-hidden disabled:opacity-50 ${className}`}
      />
      {problem && <p className="mt-3 text-sm text-[#ff7a9a]">{problem}</p>}
    </div>
  );
});
