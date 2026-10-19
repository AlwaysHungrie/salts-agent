"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";

import { FAQ } from "./content";
import { Reveal } from "./motion";
import { Eyebrow, LinkedText, Wrap } from "./ui";

/** The whole FAQ block, heading included, so app/page.tsx stays a list of sections. */
export function FaqSection() {
  return (
    <section id="faq" className="mt-20 scroll-mt-28 sm:mt-28 lg:mt-32">
      <Wrap>
        <Reveal>
          <div className="mx-auto max-w-[640px] text-center">
            <Eyebrow>{FAQ.eyebrow}</Eyebrow>
            <h2 className="mt-3 text-[clamp(30px,4.5vw,44px)] font-[650] leading-[1.08] tracking-[-0.025em]">
              {FAQ.title}
            </h2>
          </div>
        </Reveal>
        <Faq />
      </Wrap>
    </section>
  );
}

function Faq() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <div className="mx-auto mt-8 max-w-[760px] space-y-2 sm:mt-12">
      {FAQ.items.map((item, i) => {
        const isOpen = open === i;
        return (
          <div
            key={item.q}
            className={`overflow-hidden rounded-[20px] transition-colors ${
              isOpen ? "bg-canvas-soft" : "bg-canvas ring-1 ring-hairline-soft"
            }`}
          >
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : i)}
              aria-expanded={isOpen}
              className="flex w-full items-center justify-between gap-4 px-5 py-5 text-left sm:gap-6 sm:px-6"
            >
              <span className="font-semibold">{item.q}</span>
              <motion.span
                animate={{ rotate: isOpen ? 45 : 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className="grid size-7 shrink-0 place-items-center rounded-full bg-white text-muted ring-1 ring-hairline-soft"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </motion.span>
            </button>

            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                >
                  <p className="px-5 pb-6 text-sm leading-relaxed text-muted sm:px-6">{"link" in item ? <LinkedText text={item.a} link={item.link} /> : item.a}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}
