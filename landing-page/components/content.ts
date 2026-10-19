/**
 * Single source of truth for everything the landing page says and counts.
 *
 * Rules of thumb:
 *  - No copy lives in a component. If you want to reword the page, edit here.
 *  - Numbers that appear more than once are constants, never literals.
 *  - Section ids are declared in NAV (below) so the header highlight can never
 *    fall out of sync with the page order.
 */

/* --------------------------------------------------------------- Brand -- */

export const BRAND = {
  /** Product name, used in the wordmark and in running copy. */
  name: "Salts",
  /** Legal entity, used in the copyright line only. */
  legalName: "Salt Agents",
  year: 2026,
} as const;

/* ------------------------------------------------------------- Numbers -- */

/** Agents live right now. Used by the header counter and the mission maths. */
export const AGENTS_DEPLOYED = 241;

/** World population the mission counts up to, in billions. */
export const WORLD_POPULATION_B = 8.31;

/** Share of the world with an agent, as a percentage. Derived, never typed. */
export const COVERAGE_PERCENT =
  (AGENTS_DEPLOYED * 100) / (WORLD_POPULATION_B * 1_000_000_000);

/** Chat sessions one agent keeps before you need to delete older ones. */
export const SESSION_LIMIT = 256;

/** File storage one agent has, in MB. */
export const STORAGE_MB = 50;

/* ---------------------------------------------------- Navigation model -- */

/**
 * One nav entry can own several page sections. `sections` lists every section
 * id that should light this link up, in page order — so adding a new section
 * means adding its id to the group it belongs to, not adding a nav link.
 *
 * The page must render these ids in exactly this order for the highlight to
 * travel smoothly; see app/page.tsx.
 */
export const NAV = [
  { id: "skills", label: "What it does", sections: ["stats", "skills", "capabilities"] },
  { id: "how", label: "How it works", sections: ["how"] },
  { id: "costs", label: "Pricing", sections: ["costs", "mission", "fleet"] },
  { id: "faq", label: "FAQ", sections: ["faq", "start"] },
] as const;

/** Every observed section id, flattened. */
export const NAV_SECTION_IDS = NAV.flatMap((n) => n.sections);

/** Section id -> the nav entry that owns it. */
export const NAV_OWNER: Record<string, string> = Object.fromEntries(
  NAV.flatMap((n) => n.sections.map((s) => [s, n.id])),
);

/* --------------------------------------------------------------- Links -- */

/** The web app, where agents are created and managed. */
const APP_URL = "https://salts-agent-app.vercel.app";

/**
 * Every destination on the page. Entries set to `null` are not built yet and
 * render as disabled text instead of a dead `#` link — see BROKEN-LINKS.md.
 */
export const LINKS = {
  signIn: APP_URL as string | null,
  signUp: APP_URL as string | null,
  contact: null as string | null,
  privacy: "/privacy",
  terms: "/terms",
  guide: `${APP_URL}/guide`,
  fleetGuide: `${APP_URL}/guide/fleets`,
  openRouterGuide: `${APP_URL}/guide/openrouter`,
} as const;

/* ----------------------------------------------------------------- Copy -- */

export const HERO = {
  eyebrow: "In your browser, Telegram & WhatsApp",
  /** Two lines, broken where the phrase breaks on wide screens. */
  title: ["AI agents that run without a subscription.", "Or your machine."],
  body: [
    "",
    "Always on.",
    "Create one for every job and pay only for what they use.",
  ],
  primaryCta: "Get my agent",
  secondaryCta: "See what it can do",
  footnote: "Runs on your own OpenRouter API key. Usage limits apply.",
} as const;

export const STATS = [
  {
    value: "$0 a month",
    label:
      "Agents like this usually cost $20 or more a month. You only pay the model provider for what yours uses.",
  },
  {
    value: "Up to 5",
    label:
      "Agents on one account, each with its own job. Need more? Ask, or host it yourself with no limit.",
  },
  {
    value: "Open source",
    label:
      "Anyone can build on it, so it works with tools no one else supports, including the ones you built.",
  },
] as const;

export const FEATURES = {
  eyebrow: "What it can do for you",
  title: "One assistant, or a whole team of them.",
  body: `Give each ${BRAND.name} agent its own job, and it gets on with it while you get on with your day.`,
  cards: [
    {
      title: "It works with your tools, even the ones only you use",
      body: "Notion, GitHub, your company's internal app, or the product you built yourself. Closed assistants only connect to what is on their list. Salts is open source, so anything can plug in.",
      wide: true,
    },
    {
      title: "It becomes a specialist",
      body: "Add the analyst and it turns your spreadsheets into finished Excel reports. Add the recruiter and it screens CVs against your job posts. More are on the way.",
    },
    {
      title: "It remembers",
      body: "Your dog's name, your coffee order, the thing you asked it to follow up on next week. You only have to tell it once.",
    },
    {
      title: "It reminds you",
      body: "Ask it to check in at 8am, every Monday, or before your flight, and it will message you first.",
    },
    {
      title: "It lives where you already chat",
      body: "Message it on Telegram or WhatsApp like you would a friend. Send text, links, photos or voice notes, and see every conversation in your browser too.",
    },
  ],
  /** The one dark card at the end of the grid. */
  highlight: {
    title: "Run it yourself",
    body: "Host the whole thing on your own servers. Your conversations, files and keys never leave them.",
  },
} as const;

export const MISSION = {
  eyebrow: "We're on track for",
  titleSuffix: "agents.",
  subtitle: "One for each person.",
  body: "We believe every person on the planet should have open and equal access to AI.",
  coverageSuffix: "covered so far.",
} as const;

export const PRICING = {
  eyebrow: "Pricing",
  title: "No monthly fee. You only pay for the model.",
  body: `${BRAND.name} does not charge a subscription. Your agent uses your own OpenRouter API key, so you pay OpenRouter directly for the tokens your agent uses, and nothing when it is quiet. We recommend setting a spending limit on your key, so you are never surprised by your bill.`,
  bullets: [
    "See exactly what every reply cost, right under the reply",
    "Switch to a cheaper or a stronger model whenever you like",
    `Keep up to ${SESSION_LIMIT} chat sessions and ${STORAGE_MB} MB of files per agent`,
    "Or host it yourself on Cloudflare, with no usage limits at all",
  ],
  placeholder: "Placeholder — a reply with its cost shown underneath",
} as const;

export const OWNERSHIP = {
  eyebrow: "Own your agent",
  title: "Make it yours, and decide who can use it.",
  body: "Your agent's conversations and memories belong to you. You decide how it behaves, what it can do and who is allowed to talk to it.",
  bullets: [
    "Give it custom instructions, and it follows them in every conversation",
    "Choose exactly which people and groups it answers on Telegram",
    "Invite people you trust to help manage your agent",
    "Delete any conversation, or the whole agent, whenever you want",
  ],
  placeholder: "Placeholder — the settings screen for one agent",
} as const;

export const CAPABILITIES = {
  eyebrow: "Capabilities",
  title: "Switch on what you need, whenever you need it.",
  body: "Every capability is one switch away. Turn it on when you need it, and off again when you are done, so you only pay for what you use.",
  items: [
    "Search the web",
    "Read a link you send",
    "Read PDFs and files",
    "Look at photos",
    "Listen to voice notes",
    "Reply with voice notes",
    "Create images",
    "Set reminders",
    "Remember what matters",
    "Connect to Notion",
    "Connect to GitHub",
    "Analyse spreadsheets",
    "Screen candidates",
    "Connect your own tools",
  ],
  more: "More to be added over time.",
} as const;

/** A short section for Fleet Accounts. Kept modest on purpose: the page is about personal agents. */
export const FLEET = {
  eyebrow: "Fleet Accounts",
  title: "Give an agent to everyone you work with.",
  body: "Create agents for your team, your customers, or friends and family, one for each person. Your agents can share your OpenRouter API key, each with its own spending limit, so they work out of the box.",
  points: [
    {
      title: "Every agent stays private",
      body: "Each person gets their own agent, with their own chats, memories and bot. You cannot read their conversations.",
    },
    {
      title: "Users can still make it their own",
      body: "Your users can customise their agents, within the settings you allow them to change.",
    },
    {
      title: "You run the setup, they just chat",
      body: "Plug in tools like the analyst or the recruiter once, on your own machine, and everyone's agent can use them. Your users never need a computer.",
    },
  ],
  cta: "Learn about fleets",
  note: "Upgrades to Fleet Accounts are free for a limited time. Request from the app.",
} as const;

/**
 * The three-step setup, rendered in "How it works".
 */
export const STEPS = [
  {
    n: "01",
    title: "Get an OpenRouter API key",
    body: "Create an OpenRouter account, buy a few dollars of credit, and create an API key. Your agent uses it to reply to you.",
  },
  {
    n: "02",
    title: "Create your agent",
    body: "Sign in to Salts, give your agent a name and paste your key. Your agent is ready to chat in your browser straight away.",
  },
  {
    n: "03",
    optional: true,
    title: "Take it with you",
    body: "Connect Telegram or WhatsApp to talk to your agent from your phone, and switch on the capabilities you want.",
  },
] as const;

export const HOW = {
  eyebrow: "How it works",
  title: "Up and running in a few minutes.",
  guideCta: "Read the step-by-step guide",
} as const;

export const FAQ = {
  eyebrow: "FAQ",
  title: "Something on your mind?",
  items: [
    {
      q: "Is it really free?",
      a: `Yes. Running your ${BRAND.name} agent is free, within the usage limits. You only pay OpenRouter for the model tokens your agent uses, and any apps you connect that have paid plans of their own.`,
    },
    {
      q: "Why do I need my own OpenRouter API key?",
      a: "So you stay in control of what you spend. Instead of paying a fixed monthly subscription, you pay only for what your agent actually uses, and you can set your own spending limit. OpenRouter also lets you pick from hundreds of models, so you are never tied to one company.",
    },
    {
      q: "Do I have to use Telegram or WhatsApp?",
      a: "No. You can talk to your agent in your browser at any time. Telegram and WhatsApp are there so you can reach it from your phone, and every conversation shows up in your browser too.",
    },
    {
      q: "What are the usage limits?",
      a: `Each account can create up to 5 agents. Each agent can keep up to ${SESSION_LIMIT} chat sessions and ${STORAGE_MB} MB of files. When you reach a limit, delete older sessions to make room. Keep in mind that the longer a conversation gets, the more each reply costs, so we recommend starting a new one whenever you change the subject.`,
    },
    {
      q: "Can I send it files?",
      a: "Yes. You can send photos, screenshots, PDFs, text files and voice notes, as long as the matching capability is switched on.",
    },
    {
      q: "What if I need more agents or higher limits?",
      a: "Request a higher limit or a Fleet Account from the app. To remove the limits altogether, host Salts on your own Cloudflare account and pay Cloudflare for what you use.",
    },
    {
      q: "Is it really open source?",
      a: `Yes, under the Apache-2.0 licence. You can read every line, connect your own tools, or run all of ${BRAND.name} on your own servers so your data never leaves them.`,
    },
    {
      q: "I already have a coding agent.",
      a: `${BRAND.name} does not replace a coding agent that runs on your computer with access to your terminal and files. What it does is run without a computer or a subscription, so it can take care of your everyday tasks while you and your coding agent focus on the work that matters.`,
    },
  ],
} as const;

export const CTA = {
  title: "Your agent is a few minutes away.",
  body: "All you need is an OpenRouter API key. Everything else can be set up later.",
  primary: "Get my agent",
  secondary: "Read the user guide",
} as const;

export const FOOTER = {
  tagline: `${BRAND.name} is an open source AI assistant with no monthly fee and nothing to install. Use it as much as you like and pay only for what it uses. Talk to it in your browser, on Telegram or on WhatsApp.`,
  note: "No monthly fee. Self-host for no limits.",
  columns: [
    {
      title: "Product",
      links: [
        { href: "#skills", label: "What it does" },
        { href: "#how", label: "How it works" },
        { href: "#costs", label: "Pricing" },
        { href: "#fleet", label: "Fleet Accounts" },
      ],
    },
    {
      title: "Resources",
      links: [
        { href: LINKS.guide, label: "User guide" },
        { href: LINKS.openRouterGuide, label: "Get an OpenRouter key" },
        { href: "#faq", label: "FAQ" },
      ],
    },
    {
      title: "Company",
      links: [
        { href: LINKS.contact, label: "Contact" },
        { href: LINKS.privacy, label: "Privacy" },
        { href: LINKS.terms, label: "Terms" },
      ],
    },
  ],
} as const;
