"use client";

import InkDialog from "./InkDialog";

function Rule({ label }: { label: string }) {
  return (
    <div className="mb-8 mt-16 flex items-center gap-4">
      <span className="font-orbitron text-[0.6rem] font-bold uppercase tracking-[0.35em] text-white/40">
        {label}
      </span>
      <span className="h-px flex-1 bg-white/15" />
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-10 first:mt-0">
      <div className="flex items-baseline gap-3">
        <span className="font-orbitron text-xs font-bold tracking-[0.2em] text-white/35">
          {n}
        </span>
        <h3 className="font-orbitron text-base font-bold uppercase tracking-[0.12em] text-white">
          {title}
        </h3>
      </div>
      <p className="mt-3 text-base leading-[1.75] text-white/70">{children}</p>
    </div>
  );
}

/** "What is this?" → the ink dialog explaining the product. */
export default function WhatIsThis() {
  return (
    <InkDialog
      label="What is this?"
      trigger={(open) => (
        <button
          type="button"
          onClick={open}
          className="pointer-events-auto mt-5 flex h-11 animate-rain-toggle-in-late items-center rounded-full border border-white/15 bg-black/40 px-4 font-orbitron text-xs font-bold tracking-[0.2em] text-white backdrop-blur-md transition-colors duration-300 hover:border-white/40 hover:bg-black/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60 sm:fixed sm:right-19 sm:top-5 sm:z-10 sm:mt-0"
        >
          What is this?
        </button>
      )}
    >
      <div className="mx-auto max-w-[42rem]">
        <h2 className="font-orbitron text-4xl font-black uppercase leading-[0.95] text-white sm:text-6xl">
          Humans
        </h2>
        <p className="mt-5 font-orbitron text-[0.65rem] font-medium uppercase tracking-[0.42em] text-white/50">
          at Devcon VIII
        </p>

        <p className="mt-10 text-xl leading-relaxed text-white/85 sm:text-2xl">
          Find the people worth meeting at Devcon, and let them find you.
        </p>

        <p className="mt-6 text-base leading-[1.75] text-white/70">
          Type who you are looking for, or something you believe in. Your agent
          reads the profiles of everyone who has added themselves and shows you
          the people who fit, with what they work on and how to reach them.
        </p>

        <Rule label="How it works" />

        <Step n="01" title="Sign in with your ticket">
          Use the .pkpass file from your Devcon ticket. It is checked once to
          prove you are there, and never stored.
        </Step>

        <Step n="02" title="Search">
          Ask for a skill, a project, a role or an idea. Each answer lists the
          people it found, and you can ask up to five follow-ups to narrow it
          down. Every visit starts fresh: nothing you search is kept.
        </Step>

        <Step n="03" title="Add yourself">
          On your profile, tell your agent about yourself one message at a time:
          what you do, what you believe in, who you want to meet, where to reach
          you. It turns that into a profile, and people can find you once you
          press Save.
        </Step>

        <Rule label="Powered by Salts" />

        <p className="text-base leading-[1.75] text-white/70">
          Everyone who signs in gets an AI agent of their own on{" "}
          <a
            href="https://salts.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white"
          >
            Salts
          </a>
          , and that agent does your searching and keeps your notes.
        </p>

        <p className="mt-6 text-base leading-[1.75] text-white/70">
          Salts gives anyone an agent they talk to in plain words, in the
          browser, on Telegram or on WhatsApp. It can search the web, remember
          what you tell it, set reminders, and work in apps like Gmail, Notion
          and GitHub. There is no subscription: you pay only for the AI it uses,
          and you decide how it behaves and how much it spends.
        </p>
      </div>
    </InkDialog>
  );
}
