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
  { id: "skills", label: "What it does", sections: ["stats", "skills", "mission"] },
  { id: "how", label: "How it works", sections: ["how"] },
  { id: "costs", label: "Pricing", sections: ["costs", "capabilities", "fleet"] },
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
  eyebrow: "In your browser, on Telegram and on WhatsApp",
  title: "Your own AI agent. Always on.",
  body: [
    "An AI agent that works for you around the clock, and is",
    "free to run.",
    "It remembers what you tell it, reminds you when things are due, and gets things done in the apps you already use.",
  ],
  bodySecondary: "Bring your own OpenRouter API key, pick any model you like, and pay only for what your agent uses.",
  primaryCta: "Get my agent",
  secondaryCta: "See how it works",
  footnote: "Usage limits apply. Self-host on Cloudflare to remove them.",
} as const;

export const STATS = [
  {
    value: "$0",
    label:
      "To run your agent. You only pay your model provider for what your agent actually uses.",
  },
  {
    value: "24/7",
    label:
      "Your agent runs online, so it keeps working when your phone and laptop are switched off.",
  },
  {
    value: "3 ways",
    label:
      "To talk to it: in your browser, on Telegram, or on WhatsApp. It is the same agent everywhere.",
  },
] as const;

export const FEATURES = {
  eyebrow: "What it can do for you",
  title: "More than a chatbot",
  body: `A chatbot answers questions while you have it open. Your ${BRAND.name} agent does things for you, and keeps going when you close the tab. Switch on only what you need, and reach out to us if there is something you would like it to do.`,
  cards: [
    {
      title: "It lives where you already chat",
      body: "Message your agent on Telegram or WhatsApp just like you would message a friend. Type, forward a link, send a photo, or record a voice note. Every conversation also shows up in your browser.",
      wide: true,
    },
    {
      title: "It remembers",
      body: "Your dog's name, your coffee order, the thing you asked it to follow up on next week. You only have to tell it once.",
    },
    {
      title: "It looks things up",
      body: "It searches the web, reads the links and files you send it, and tells you where the answer came from.",
    },
    {
      title: "It reminds you",
      body: "Ask it to check in at 8am, every Monday, or before your flight, and it will message you first.",
    },
    {
      title: "It works in your apps",
      body: "Connect Notion, GitHub and other apps, and ask your agent to add a task, find a page or open an issue for you.",
    },
  ],
  /** The one dark card at the end of the grid. */
  highlight: {
    title: "You are in control",
    body: "You choose the model, what your agent can do, who it talks to and how much it can spend.",
  },
} as const;

export const MISSION = {
  eyebrow: "Not stopping until",
  titleSuffix: "agents.",
  subtitle: "One for each person.",
  body: "We believe every person on the planet should have open and equal access to their own AI agent.",
  coverageSuffix: "covered so far.",
} as const;

export const PRICING = {
  eyebrow: "Pricing",
  title: "Free to run. You only pay for the model.",
  body: `${BRAND.name} does not charge a subscription. Your agent uses your own OpenRouter API key, so you pay OpenRouter directly for the tokens your agent uses, and nothing when it is quiet. We recommend setting a spending limit on your key, so you are never surprised by your bill.`,
  bullets: [
    "See exactly what every reply cost, right under the reply",
    "Switch to a cheaper or a stronger model whenever you like",
    `Keep up to ${SESSION_LIMIT} chat sessions and ${STORAGE_MB} MB of files per agent`,
    "Self-host on your own Cloudflare account to remove every usage limit",
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
    "Connect any MCP server",
  ],
  more: "More added all the time.",
} as const;

/** A short section for Fleet Accounts. Kept modest on purpose: the page is about personal agents. */
export const FLEET = {
  eyebrow: "Fleet Accounts",
  title: "Give an agent to everyone you work with.",
  body: "Create agents for your team, your customers, or friends and family, one for each person. Your agents can share your OpenRouter API key, each with its own spending limit, so they work from day one.",
  points: [
    {
      title: "Every agent stays private",
      body: "Each person gets their own agent, with their own chats, memories and bot. You cannot read their conversations.",
    },
    {
      title: "They can make it their own",
      body: "Your users can still customise their agent, within the settings you allow them to change.",
    },
    {
      title: "Manage them in one place",
      body: "Change settings for everyone at once or for one person, and add or remove people at any time.",
    },
  ],
  cta: "Learn about fleets",
  note: "Fleet Accounts are free for a limited time. Request one from the app.",
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
      a: `Each account can create one agent. Each agent can keep up to ${SESSION_LIMIT} chat sessions and ${STORAGE_MB} MB of files. When you reach a limit, delete older sessions to make room. Keep in mind that the longer a conversation gets, the more each reply costs, so we recommend starting a new one whenever you change the subject.`,
    },
    {
      q: "Can I send it files?",
      a: "Yes. You can send photos, screenshots, PDFs, text files and voice notes, as long as the matching capability is switched on.",
    },
    {
      q: "What if I need more agents or higher limits?",
      a: "If you want to give agents to other people, request a Fleet Account from the app. If you want to remove the usage limits altogether, you can host Salts on your own Cloudflare account and pay Cloudflare for what you use.",
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
  tagline: `${BRAND.name} is a personal AI agent that is always on and free to run. Talk to it in your browser, on Telegram or on WhatsApp.`,
  note: "Free to run. Self-host for higher usage limits.",
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
