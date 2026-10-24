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

function Role({
  name,
  does,
  earns,
}: {
  name: string;
  does: string;
  earns: string;
}) {
  return (
    <div className="rounded-lg border border-white/15 p-5">
      <p className="font-orbitron text-sm font-bold uppercase tracking-[0.2em] text-white">
        {name}
      </p>
      <p className="mt-3 text-[0.95rem] leading-relaxed text-white/70">
        {does}
      </p>
      <p className="mt-4 font-orbitron text-[0.65rem] font-bold uppercase tracking-[0.2em] text-white/80">
        {earns}
      </p>
    </div>
  );
}

function Term({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-l border-white/20 pl-4">
      <p className="text-amber-600 font-orbitron text-[0.6rem] font-bold uppercase tracking-[0.28em]">
        {label}
      </p>
      <p className="mt-2 text-[0.95rem] leading-relaxed text-white/70">
        {children}
      </p>
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

function Cut({ pct, who }: { pct: string; who: string }) {
  return (
    <div className="rounded-lg border border-white/15 py-5">
      <p className="font-orbitron text-3xl font-black text-white">{pct}%</p>
      <p className="mt-2 font-orbitron text-[0.6rem] font-medium uppercase tracking-[0.28em] text-white/50">
        {who}
      </p>
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
          Mooned hunts down top tokens and snipes them right when they launch.
        </p>

        <p className="mt-6 text-base leading-[1.75] text-white/70">
          The Machine identifies tokens that don&rsquo;t exist yet but should
          &mdash; projects shipping quietly, memes picking up speed, events the
          market hasn&rsquo;t caught. It puts automated workers on them, and the
          moment a launch is confirmed, it opens a position. It liquidates half
          of that position on the first jump in market cap.
        </p>

        <Rule label="You can make money" />

        <div className="grid gap-6 sm:grid-cols-2">
          <Role
            name="Informer"
            does="Convince the Machine of a potential 10x before it launches. Back it with evidence: links, Official Sources, timelines."
            earns="25% of earnings"
          />
          <Role
            name="Tracker"
            does="Sponsor the cloud workers that watch for the launch event. You can sponsor the identified Watch Window by the minute."
            earns="35% of earnings"
          />
        </div>

        <Rule label="How it works" />

        <Step n="01" title="Convince the Machine">
          Informers get a chat session with the Machine, where they must
          convince the AI of a potential launch. Informers need to argue for
          their case and provide links, timelines, the accounts a launch would
          show up on. When the AI is convinced, the Machine will approve the
          following:
        </Step>

        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <Term label="Rating">
            How far the coin will run. 5x, 10x, 15x, 50x.
          </Term>
          <Term label="Watch Window">
            A time interval in which workers could be deployed to watch for the
            launch event.
          </Term>
          <Term label="Approved Amount">
            How much of its own money the Machine will commit.
          </Term>
          <Term label="Official Sources">
            Approved accounts and venues that can act as a source of launch
            event confirmations.
          </Term>
        </div>

        <Step n="02" title="Trackers sponsor the Watch Window">
          One minute of the Watch Window costs $0.001. A Tracker can sponsor any
          number of minutes, and the Machine deploys workers to watch for the
          launch event at equally spaced intervals based on the sponsorship
          received. The higher the sponsorship received, the better the chances
          of detecting the launch early.
        </Step>

        <Step n="03" title="Machine finds the launch">
          If a worker confirms the launch, the Machine will first check whether
          it is still early to buy. If the market cap is below $10k, it will use
          the Approved Amount and unused sponsorship funds to open a position.
        </Step>

        <Step n="04" title="Machine exits the trade">
          When the market cap reaches the multiple identified in the Rating, the
          Machine liquidates half the position and leaves the rest with the DAO.
        </Step>

        <Step n="05" title="Profits are shared">
          The treasury takes back the Approved Amount first. Whatever is left
          gets split three ways.
        </Step>

        <div className="mt-8 grid grid-cols-3 gap-4 text-center">
          <Cut pct="35" who="Sponsors" />
          <Cut pct="25" who="Informer" />
          <Cut pct="40" who="Treasury" />
        </div>

        <p className="mt-6 text-[0.95rem] leading-[1.75] text-white/55">
          Each Sponsor receives a share proportional to the number of minutes
          they sponsored. All infrastructure and LLM costs are borne by the
          treasury.
        </p>

        <p className="mt-16 font-orbitron text-[0.6rem] font-medium uppercase tracking-[0.42em] text-white/35">
          Operated by the Whitepaper DAO
        </p>
      </div>
    </InkDialog>
  );
}
