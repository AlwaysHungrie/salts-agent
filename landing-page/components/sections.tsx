import { ApiKeysPreview } from "./ApiKeysPreview";
import { TelegramSettingsPreview } from "./TelegramSettingsPreview";
import { AppPreview } from "./AppPreview";
import {
  CAPABILITIES as CAPABILITIES_COPY,
  COVERAGE_PERCENT,
  CTA as CTA_COPY,
  FEATURES as FEATURES_COPY,
  FLEET,
  HERO,
  HOW,
  LINKS,
  MISSION,
  OWNERSHIP,
  PRICING,
  STATS as STATS_COPY,
  STEPS,
  WORLD_POPULATION_B,
} from "./content";
import { Globe } from "./Globe";
import { CountUp, HeroSquircles, Reveal } from "./motion";
import { Button, Eyebrow, Placeholder, Wrap } from "./ui";
import type { ReactNode } from "react";

/*
 * Every string on this page comes from ./content.ts. These components only
 * decide how copy is laid out, never what it says.
 */

/* ---------------------------------------------------------------- Hero -- */

export function Hero() {
  return (
    <section className="relative overflow-hidden pt-28 pb-8 sm:pt-36 sm:pb-10 lg:pt-44">
      {/* A single faint wash behind the headline; no gradients elsewhere. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(60%_60%_at_50%_0%,#f3f3f3_0%,#ffffff_70%)]"
      />

      {/* Squircle slots stand in for the app icons this page will eventually show. */}
      <HeroSquircles />

      <Wrap className="relative text-center">
        <Reveal>
          <span className="inline-flex items-center gap-2 rounded-[10px] bg-canvas-soft px-3 py-1.5 text-[12px] font-semibold text-muted sm:px-4 sm:py-2 sm:text-[13px]">
            {HERO.eyebrow}
          </span>
        </Reveal>

        <Reveal delay={0.05}>
          <h1 className="mx-auto mt-5 max-w-[15ch] text-[clamp(34px,9vw,84px)] font-[650] leading-[1.02] tracking-[-0.03em] text-balance sm:mt-6 sm:leading-[0.98]">
            {HERO.title}
          </h1>
        </Reveal>

        <Reveal delay={0.1}>
          <p className="mx-auto mt-5 max-w-[680px] text-[16px] font-light leading-[1.5] text-muted text-balance sm:mt-6 sm:text-xl sm:leading-[1.4]">
            {HERO.body[0]} <span className="font-medium">{HERO.body[1]}</span>{" "}
            {HERO.body[2]}
          </p>
          <p className="mx-auto mt-4 max-w-[620px] text-[16px] font-light leading-[1.5] text-muted text-balance sm:mt-6 sm:text-xl sm:leading-[1.4]">
            {HERO.bodySecondary}
          </p>
        </Reveal>

        <Reveal delay={0.15}>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Button href={LINKS.signUp ?? "#start"}>{HERO.primaryCta}</Button>
            <Button href="#how" variant="outline">
              {HERO.secondaryCta}
            </Button>
          </div>
          <p className="mt-4 text-[13px] text-faint sm:text-sm">
            {HERO.footnote}
          </p>
        </Reveal>

        <Reveal delay={0.2}>
          <AppPreview className="mt-16 sm:mt-24 lg:mt-32" />
        </Reveal>
      </Wrap>
    </section>
  );
}

/* --------------------------------------------------------------- Stats -- */

export function Stats() {
  return (
    <section id="stats" className="mt-16 scroll-mt-28 sm:mt-20 lg:mt-24">
      <Wrap>
        <Reveal>
          <div className="grid gap-px overflow-hidden rounded-[24px] bg-hairline-soft sm:grid-cols-3">
            {STATS_COPY.map((s) => (
              <div key={s.value} className="bg-canvas p-8">
                <p className="tnum text-[40px] font-[650] leading-none tracking-[-0.03em]">
                  {s.value}
                </p>
                <p className="mt-3 text-sm leading-relaxed text-muted">
                  {s.label}
                </p>
              </div>
            ))}
          </div>
        </Reveal>
      </Wrap>
    </section>
  );
}

/* ------------------------------------------------------------ Features -- */

export function Features() {
  return (
    <section id="skills" className="mt-20 scroll-mt-28 sm:mt-28 lg:mt-32">
      <Wrap>
        <Reveal>
          <div className="mx-auto max-w-[640px] text-center">
            <Eyebrow>{FEATURES_COPY.eyebrow}</Eyebrow>
            <h2 className="mt-3 text-[clamp(30px,4.5vw,44px)] font-[650] leading-[1.08] tracking-[-0.025em]">
              {FEATURES_COPY.title}
            </h2>
            <p className="mt-4 text-base sm:text-xl font-light leading-[1.4] text-muted text-balance">
              {FEATURES_COPY.body}
            </p>
          </div>
        </Reveal>

        <div className="mt-8 grid gap-4 sm:mt-12 md:grid-cols-3">
          {FEATURES_COPY.cards.map((f, i) => (
            <Reveal
              key={f.title}
              delay={i * 0.05}
              className={"wide" in f && f.wide ? "md:col-span-2" : ""}
            >
              <article className="flex h-full flex-col rounded-[24px] bg-canvas p-7 ring-1 ring-hairline-soft transition-colors hover:bg-canvas-soft">
                <h3 className="text-xl font-semibold tracking-[-0.01em]">
                  {f.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  {f.body}
                </p>
              </article>
            </Reveal>
          ))}
          <Reveal delay={FEATURES_COPY.cards.length * 0.05}>
            <article className="flex h-full flex-col justify-between rounded-[24px] bg-ink p-7 text-white">
              <h3 className="text-xl font-semibold tracking-[-0.01em]">
                {FEATURES_COPY.highlight.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-faint">
                {FEATURES_COPY.highlight.body}
              </p>
            </article>
          </Reveal>
        </div>
      </Wrap>
    </section>
  );
}

/* -------------------------------------------------------------- Mission -- */

export function Mission() {
  return (
    <section id="mission" className="mt-20 scroll-mt-28 sm:mt-28 lg:mt-32">
      <Wrap>
        <Reveal>
          <div className="relative overflow-hidden rounded-[32px] bg-ink px-5 py-12 text-center text-white sm:px-12 sm:py-16 lg:py-20">
            {/* Cropped by the card edge, so it reads as a world still turning. */}
            <Globe className="pointer-events-none absolute right-0 top-1/2 hidden h-[520px] w-[520px] -translate-y-1/2 translate-x-[45%] lg:block" />
            <div className="relative">
              <p className="text-xs tracking-[0.08em] text-faint">
                {MISSION.eyebrow}
              </p>
              <h2 className="mx-auto mt-3 max-w-[18ch] text-[clamp(26px,3.5vw,38px)] font-[650] leading-[1.1] tracking-[-0.025em] text-balance">
                <CountUp to={WORLD_POPULATION_B} decimals={2} suffix="B" />{" "}
                {MISSION.titleSuffix}
              </h2>
              <h2 className="mx-auto max-w-[18ch] text-[clamp(26px,3.5vw,38px)] font-[650] leading-[1.1] tracking-[-0.025em] text-balance">
                {MISSION.subtitle}
              </h2>
              <p className="mx-auto mt-4 max-w-[540px] text-lg font-light leading-[1.45] text-faint text-balance">
                {MISSION.body}
              </p>
              <p className="mt-8 text-sm text-faint">
                <span className="font-semibold text-white">
                  <CountUp to={COVERAGE_PERCENT} decimals={6} suffix="%" />
                </span>{" "}
                {MISSION.coverageSuffix}
              </p>
            </div>
          </div>
        </Reveal>
      </Wrap>
    </section>
  );
}

/* --------------------------------------------------------------- Split -- */

function Split({
  eyebrow,
  title,
  body,
  bullets,
  label,
  visual,
  reverse = false,
}: {
  eyebrow: string;
  title: string;
  body: string;
  bullets: readonly string[];
  label: string;
  /** A drawn stand-in, where there is one; otherwise the labelled slot. */
  visual?: ReactNode;
  reverse?: boolean;
}) {
  return (
    <div className="grid items-center gap-8 sm:gap-12 md:grid-cols-2">
      <Reveal className={reverse ? "md:order-2" : ""}>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 className="mt-3 text-[clamp(26px,3.5vw,34px)] font-[650] leading-[1.1] tracking-[-0.025em]">
          {title}
        </h2>
        <p className="mt-4 leading-relaxed text-muted">{body}</p>
        <ul className="mt-6">
          {bullets.map((b) => (
            <li
              key={b}
              className="border-t border-hairline-soft py-3 text-sm leading-relaxed"
            >
              {b}
            </li>
          ))}
        </ul>
      </Reveal>
      <Reveal delay={0.08}>
        {visual ?? <Placeholder frame label={label} />}
      </Reveal>
    </div>
  );
}

export function Costs() {
  return (
    <section
      id="costs"
      className="mt-20 scroll-mt-28 space-y-16 sm:mt-28 sm:space-y-20 lg:mt-32 lg:space-y-24"
    >
      <Wrap>
        <Split
          eyebrow={PRICING.eyebrow}
          title={PRICING.title}
          body={PRICING.body}
          bullets={PRICING.bullets}
          label={PRICING.placeholder}
          visual={<ApiKeysPreview />}
        />
      </Wrap>
      <Wrap>
        <Split
          reverse
          eyebrow={OWNERSHIP.eyebrow}
          title={OWNERSHIP.title}
          body={OWNERSHIP.body}
          bullets={OWNERSHIP.bullets}
          label={OWNERSHIP.placeholder}
          visual={<TelegramSettingsPreview />}
        />
      </Wrap>
    </section>
  );
}

/* -------------------------------------------------------- Capabilities -- */

export function Capabilities() {
  return (
    <section id="capabilities" className="mt-20 scroll-mt-28 sm:mt-28 lg:mt-32">
      <Wrap>
        <Reveal>
          <div className="rounded-[32px] bg-canvas-soft px-5 py-7 sm:p-8 lg:p-12">
            <div className="max-w-[560px]">
              <Eyebrow>{CAPABILITIES_COPY.eyebrow}</Eyebrow>
              <h2 className="mt-3 text-[clamp(26px,3.5vw,34px)] font-[650] leading-[1.1] tracking-[-0.025em]">
                {CAPABILITIES_COPY.title}
              </h2>
              <p className="mt-3 text-[15px] leading-relaxed text-muted sm:mt-4 sm:text-base">
                {CAPABILITIES_COPY.body}
              </p>
            </div>
            <div className="mt-6 flex flex-wrap gap-1.5 sm:mt-8 sm:gap-2">
              {CAPABILITIES_COPY.items.map((c) => (
                <span
                  key={c}
                  className="rounded-full bg-canvas px-3 py-1.5 text-[13px] ring-1 ring-hairline-soft sm:px-4 sm:py-2 sm:text-sm"
                >
                  {c}
                </span>
              ))}
              <span className="rounded-full px-3 py-1.5 text-[13px] text-faint ring-1 ring-hairline sm:px-4 sm:py-2 sm:text-sm">
                {CAPABILITIES_COPY.more}
              </span>
            </div>
          </div>
        </Reveal>
      </Wrap>
    </section>
  );
}

/* --------------------------------------------------------------- Fleet -- */

/** A short, quiet section: fleets matter, but the page is about personal agents. */
export function Fleet() {
  return (
    <section id="fleet" className="mt-20 scroll-mt-28 sm:mt-28 lg:mt-32">
      <Wrap>
        <Reveal>
          <div className="max-w-[640px]">
            <Eyebrow>{FLEET.eyebrow}</Eyebrow>
            <h2 className="mt-3 text-[clamp(26px,3.5vw,34px)] font-[650] leading-[1.1] tracking-[-0.025em]">
              {FLEET.title}
            </h2>
            <p className="mt-4 leading-relaxed text-muted">{FLEET.body}</p>
          </div>
        </Reveal>

        <div className="mt-8 grid gap-6 sm:mt-10 md:grid-cols-3">
          {FLEET.points.map((p, i) => (
            <Reveal key={p.title} delay={i * 0.05}>
              <div className="border-t border-hairline pt-5">
                <h3 className="text-base font-semibold tracking-[-0.01em]">
                  {p.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  {p.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal>
          <div className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-5">
            <Button href={LINKS.fleetGuide} variant="outline">
              {FLEET.cta}
            </Button>
            <p className="text-sm text-faint">{FLEET.note}</p>
          </div>
        </Reveal>
      </Wrap>
    </section>
  );
}

/* --------------------------------------------------------------- Steps -- */

/** The three-step setup, rendered identically wherever it appears. */
export function StepList() {
  return (
    <div className="grid gap-6 text-left sm:gap-8 md:grid-cols-3">
      {STEPS.map((s, i) => (
        <Reveal key={s.n} delay={i * 0.06}>
          <div className="border-t border-hairline pt-5">
            <p className="tnum text-sm font-semibold text-faint">
              {s.n}
              {"optional" in s && s.optional ? " (Optional)" : ""}
            </p>
            <h3 className="mt-2 text-xl font-semibold tracking-[-0.01em]">
              {s.title}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
          </div>
        </Reveal>
      ))}
    </div>
  );
}

export function Steps() {
  return (
    <section id="how" className="mt-20 scroll-mt-28 sm:mt-28 lg:mt-32">
      <Wrap>
        <Reveal>
          <div className="mx-auto max-w-[640px] text-center">
            <Eyebrow>{HOW.eyebrow}</Eyebrow>
            <h2 className="mt-3 text-[clamp(30px,4.5vw,44px)] font-[650] leading-[1.08] tracking-[-0.025em]">
              {HOW.title}
            </h2>
          </div>
        </Reveal>

        <div className="mt-8 sm:mt-12">
          <StepList />
        </div>

        <Reveal>
          <div className="mt-10 text-center">
            <Button href={LINKS.guide} variant="outline">
              {HOW.guideCta}
            </Button>
          </div>
        </Reveal>
      </Wrap>
    </section>
  );
}

/* ----------------------------------------------------------------- CTA -- */

export function Cta() {
  return (
    <section
      id="start"
      className="mt-20 scroll-mt-28 pb-10 sm:mt-28 sm:pb-24 lg:mt-32 lg:pb-32"
    >
      <Wrap>
        <Reveal>
          <div className="rounded-[32px] bg-canvas-soft px-5 pt-12 pb-8 sm:px-12 sm:py-16 lg:py-20">
            <div className="mx-auto max-w-[640px] text-center">
              <h2 className="text-[clamp(30px,4.5vw,44px)] font-[650] leading-[1.08] tracking-[-0.025em]">
                {CTA_COPY.title}
              </h2>
              <p className="mx-auto mt-4 max-w-[520px] text-xl font-light leading-[1.4] text-muted text-balance">
                {CTA_COPY.body}
              </p>
            </div>

            <div className="mt-8 flex flex-col justify-center gap-3 sm:mt-10 sm:flex-row">
              <Button href={LINKS.signUp ?? "#how"}>{CTA_COPY.primary}</Button>
              <Button href={LINKS.guide} variant="outline">
                {CTA_COPY.secondary}
              </Button>
            </div>
          </div>
        </Reveal>
      </Wrap>
    </section>
  );
}
