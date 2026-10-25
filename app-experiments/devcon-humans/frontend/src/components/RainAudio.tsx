"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Ambient rain bed for the night-street hero.
 *
 * The loop is played through Web Audio rather than an <audio loop> element:
 * container padding on compressed formats leaves an audible gap at the seam,
 * and a decoded AudioBuffer repeats sample-accurately instead. Gain is ramped
 * on both edges so the bed swells in rather than snapping on.
 *
 * Browsers refuse to start audible playback without a gesture, so nothing is
 * fetched until the first one lands anywhere on the page. The bed then plays
 * until muted, and every load starts it again — the choice is not remembered.
 *
 * Mounted once in the root layout, so it keeps playing from the front page to
 * search and profile.
 */

const SRC = "/audio/rain-loop.m4a";
const LEVEL = 0.5;
const FADE_IN = 2.5;
const FADE_OUT = 0.6;

export default function RainAudio() {
  const [on, setOn] = useState(false);

  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);

  // start() awaits a fetch and a decode, so two calls can overlap — the armed
  // first-gesture listener and a click on the toggle both fire on the same
  // press. Every start claims a ticket and drops out if it has been superseded,
  // which keeps a single source node on the graph.
  const startSeqRef = useRef(0);

  const stop = useCallback(() => {
    startSeqRef.current += 1;

    const ctx = ctxRef.current;
    const gain = gainRef.current;
    const source = sourceRef.current;
    if (!ctx || !gain || !source) return;

    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0.0001, now + FADE_OUT);
    source.stop(now + FADE_OUT);

    sourceRef.current = null;
  }, []);

  const start = useCallback(async () => {
    const seq = (startSeqRef.current += 1);

    // Created on demand: an AudioContext made during render starts suspended
    // and counts against the browser's per-page limit for nothing.
    const ctx = (ctxRef.current ??= new AudioContext());
    if (ctx.state === "suspended") await ctx.resume();

    if (!bufferRef.current) {
      const res = await fetch(SRC);
      if (!res.ok) throw new Error(`rain loop ${res.status}`);
      bufferRef.current = await ctx.decodeAudioData(await res.arrayBuffer());
    }

    // Another start, or a stop, landed while this one was decoding.
    if (seq !== startSeqRef.current) return;

    // A source node is single-use, so each start gets a fresh one.
    stop();
    const gain = (gainRef.current ??= ctx.createGain());
    gain.connect(ctx.destination);

    const source = ctx.createBufferSource();
    source.buffer = bufferRef.current;
    source.loop = true;
    source.connect(gain);

    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(LEVEL, now + FADE_IN);

    // Start at a random point so a reload does not replay the same 26 seconds.
    source.start(now, Math.random() * bufferRef.current.duration);
    sourceRef.current = source;
  }, [stop]);

  const toggle = useCallback(() => {
    setOn((wasOn) => {
      const next = !wasOn;
      if (next) {
        start().catch((err) => {
          console.warn("rain: start failed", err);
          setOn(false);
        });
      } else {
        stop();
      }
      return next;
    });
  }, [start, stop]);

  // The bed is on by default, but audio is only allowed after a gesture, so arm
  // the first one made anywhere on the page.
  useEffect(() => {
    const events = ["pointerdown", "keydown", "touchstart"] as const;
    const resume = () => {
      start().then(
        () => setOn(true),
        (err) => console.warn("rain: autostart failed", err),
      );
      events.forEach((e) => window.removeEventListener(e, resume, true));
    };
    // Capture phase: the gesture counts wherever it lands, even if something
    // between the target and window stops the event bubbling.
    events.forEach((e) =>
      window.addEventListener(e, resume, { capture: true }),
    );
    return () =>
      events.forEach((e) => window.removeEventListener(e, resume, true));
  }, [start]);

  useEffect(
    () => () => {
      sourceRef.current?.stop();
      ctxRef.current?.close();
    },
    [],
  );

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={on}
      aria-label={on ? "Mute rain" : "Play rain"}
      className="group pointer-events-auto fixed top-5 right-5 z-30 flex size-11 animate-rain-toggle-in items-center justify-center rounded-full border border-white/15 bg-black/40 text-white/55 backdrop-blur-md transition-colors duration-500 hover:border-white/30 hover:text-white/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60 sm:bottom-7 sm:right-7"
    >
      {on ? <Bars /> : <SpeakerIcon />}
    </button>
  );
}

/** Four bars, rendered only while the bed is audible. */
function Bars() {
  return (
    <span aria-hidden className="flex h-3 items-end gap-[3px]">
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          style={{ animationDelay: `${i * 0.16}s` }}
          className="h-3 w-[2px] rounded-full bg-current motion-safe:animate-rain-bar"
        />
      ))}
    </span>
  );
}

/** Speaker, shown while the bed is silent — the sound on offer, not its state. */
function SpeakerIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[18px]"
    >
      <path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" />
      <path d="M15 9.5a4 4 0 0 1 0 5" />
      <path d="M17.8 7a7.5 7.5 0 0 1 0 10" />
    </svg>
  );
}
