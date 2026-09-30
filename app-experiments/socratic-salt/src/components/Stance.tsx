"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { CheckCircle2, Scale } from "lucide-react";
import { Markdown } from "./Markdown";
import type { Stance } from "@/lib/stance";

/** The chat reports the latest stance; the brief pane shows it. */
const StanceContext = createContext<{ stance: Stance | null; setStance: (s: Stance | null) => void }>({
  stance: null,
  setStance: () => {},
});

export function StanceProvider({ children }: { children: ReactNode }) {
  const [stance, setStance] = useState<Stance | null>(null);
  return <StanceContext.Provider value={{ stance, setStance }}>{children}</StanceContext.Provider>;
}

export const useSetStance = () => useContext(StanceContext).setStance;

export function StanceCard() {
  const { stance } = useContext(StanceContext);
  if (!stance) return null;
  const Icon = stance.concluded ? CheckCircle2 : Scale;
  return (
    <div className="from-left bg-ink mb-4 rounded-3xl px-5 py-6 text-white sm:px-8">
      <p className="flex items-center gap-2 text-xs font-semibold tracking-[0.08em] text-white/60 uppercase">
        <Icon className="size-3.5" strokeWidth={2} /> {stance.concluded ? "Conclusion" : "Where it stands"}
      </p>
      {stance.summary && (
        <p className="mt-3 text-[17px] leading-[1.35] font-[650] tracking-[-0.01em]">{stance.summary}</p>
      )}
      {stance.body && (
        <Markdown className="stance mt-3 text-[14px] text-white/80">{stance.body}</Markdown>
      )}
    </div>
  );
}
