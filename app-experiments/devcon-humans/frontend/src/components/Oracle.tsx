"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { citedPeople } from "@/lib/people";
import { sendMessage, visibleReply } from "@/lib/reply";
import { Markdown } from "./Markdown";
import { PersonCard } from "./PersonCard";
import { TerminalInput } from "./TerminalInput";

type Turn = { id: number; query: string; answer: string; error: string };

/** Follow-ups one search allows before it has to start over. */
const MAX_FOLLOW_UPS = 5;

/**
 * Search, oracle style: one line to type who you are looking for (or something you believe
 * in), the answer and the people it names laid out as results, then follow-ups that keep the
 * thread, up to MAX_FOLLOW_UPS of them, then a restart. A fresh session every time the page
 * opens; nothing is kept between visits.
 */
export function Oracle() {
  const [ready, setReady] = useState(false);
  const [startError, setStartError] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const last = useRef<HTMLElement>(null);

  // A new session on the agent, the last one deleted. State changes only once it answers.
  const start = useCallback(async (live: () => boolean = () => true) => {
    try {
      // 409: the agent is being set up by another tab; wait for it rather than fail.
      for (let tries = 0; ; tries++) {
        const res = await fetch("/api/chat", { method: "PUT" });
        if (res.ok) break;
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status !== 409 || tries >= 20) throw new Error(body.error || "The terminal didn’t start. Refresh the page.");
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (live()) setReady(true);
    } catch (err) {
      if (live()) setStartError(err instanceof Error ? err.message : "The terminal didn’t start. Refresh the page.");
    }
  }, []);

  useEffect(() => {
    let live = true;
    void start(() => live);
    return () => {
      live = false;
    };
  }, [start]);

  function restart() {
    setTurns([]);
    setDraft("");
    setReady(false);
    setStartError("");
    void start();
  }

  async function ask() {
    const text = draft.trim();
    if (!text || busy || !ready || turns.length > MAX_FOLLOW_UPS) return;
    const id = Date.now();
    setDraft("");
    setBusy(true);
    setTurns((t) => [...t, { id, query: text, answer: "", error: "" }]);
    const update = (change: (t: Turn) => Turn) => setTurns((all) => all.map((t) => (t.id === id ? change(t) : t)));
    requestAnimationFrame(() => last.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    try {
      await sendMessage("/api/chat", text, {
        onText: (d) => update((t) => ({ ...t, answer: t.answer + d })),
        onTool: setTool,
      });
    } catch (err) {
      update((t) => ({ ...t, error: err instanceof Error ? err.message : "Something went wrong. Try again." }));
    } finally {
      setBusy(false);
      requestAnimationFrame(() => input.current?.focus());
    }
  }

  if (turns.length === 0)
    return (
      <section className="flex flex-1 flex-col pt-12 pb-10 sm:justify-center sm:py-10">
        <h1 className="font-orbitron text-3xl font-black uppercase leading-[1.05] text-white sm:text-5xl">
          Who are you
          <br />
          looking for?
        </h1>
        <p className="mt-4 max-w-xl text-lg text-white/55">
          Or say something you believe in. We’ll find the people at Devcon who think alike.
        </p>
        <div className="mt-10">
          <TerminalInput
            ref={input}
            id="search"
            label="Who are you looking for?"
            value={draft}
            onChange={setDraft}
            onSubmit={() => void ask()}
            disabled={!ready}
            autoFocus
            placeholder={ready || startError ? "Type here…" : "Waking your agent…"}
            className="text-2xl leading-snug sm:text-4xl"
          />
        </div>
        {startError && (
          <p role="alert" className="mt-4 text-[#ff7a9a]">
            {startError}
          </p>
        )}
      </section>
    );

  const followUps = turns.length - 1;

  return (
    <div className="flex flex-col gap-14 py-8">
      {turns.map((t, i) => {
        const answer = visibleReply(t.answer);
        const people = citedPeople(answer);
        const current = i === turns.length - 1;
        // A reply that was only a tool call written out: the turn ran out of steps.
        const stalled = !(current && busy) && !answer && !!t.answer && !t.error;
        return (
          <article key={t.id} ref={current ? last : undefined} className="scroll-mt-6">
            <h2 className="text-2xl font-semibold leading-snug tracking-tight text-balance text-white sm:text-3xl">
              {t.query}
            </h2>
            <div className="mt-4">
              {answer && (
                // While the reply streams, a cursor follows its last word (globals.css, .streaming).
                <Markdown className={`md-dark text-[1.05rem] ${current && busy ? "streaming" : ""}`}>{answer}</Markdown>
              )}
              {stalled && (
                <p className="text-white/60">The terminal ran out of steps on this one. Ask again, or narrow it down.</p>
              )}
              {current && busy && !answer && (
                <p className="terminal-text text-xl leading-none">
                  {tool ? "SEARCHING" : "THINKING"}
                  <span className="terminal-cursor" aria-hidden />
                </p>
              )}
              {t.error && (
                <p role="alert" className="mt-2 text-[#ff7a9a]">
                  {t.error}
                </p>
              )}
            </div>
            {people.length > 0 && (
              <div className="mt-6 grid gap-3">
                {people.map((id) => (
                  <PersonCard key={id} id={id} />
                ))}
              </div>
            )}
          </article>
        );
      })}

      {!busy &&
        (followUps < MAX_FOLLOW_UPS ? (
          <TerminalInput
            ref={input}
            id="follow-up"
            label="Ask a follow-up"
            value={draft}
            onChange={setDraft}
            onSubmit={() => void ask()}
            placeholder={
              // The count shows from the third follow-up on.
              followUps < 2 ? "Ask a follow-up…" : `Ask a follow-up… (${MAX_FOLLOW_UPS - followUps} remaining)`
            }
            className="text-xl leading-snug sm:text-2xl"
          />
        ) : (
          <button
            type="button"
            onClick={restart}
            className="rise-in h-11 w-fit rounded-full bg-white px-6 font-orbitron text-xs font-bold tracking-[0.2em] text-black uppercase transition-opacity duration-300 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
          >
            Restart
          </button>
        ))}
    </div>
  );
}
