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
  { id: "fleet", label: "Fleet", sections: ["mission", "fleet", "faq", "start"] },
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
  stepByStepGuide: `${APP_URL}/guide/step-by-step-agent`,
  githubIssues: "https://github.com/AlwaysHungrie/salts-agent/issues/new",
  fleetGuide: `${APP_URL}/guide/fleets`,
  openRouterGuide: `${APP_URL}/guide/openrouter`,
} as const;

/* ----------------------------------------------------------------- Copy -- */

export const HERO = {
  eyebrow: "In your browser, Telegram & WhatsApp",
  /** Two lines, broken where the phrase breaks on wide screens. */
  /** The last part renders a shade lighter than the rest. */
  title: ["Personal AI agents", "that stay with you", "forever."],
  body: [
    "",
    "No subscription. No hardware.",
    "Salts agents live in the cloud for free and are yours to personalize. Create as many as you want and pay just a few cents when they respond.",
  ],
  primaryCta: "Get my agent",
  secondaryCta: "See what it can do",
  footnote: "We're open source. Feel free to bring your own keys or self-host your agents.",
} as const;

export const STATS = [
  {
    value: "$0",
    label:
      "to run. You only pay per message, from about $0.001 up to $0.03 on the most advanced models.",
  },
  {
    value: "Full control",
    label:
      "over costs, only use as much or as little as you need. Switch to any model, toggle capabilities, and gate access anytime you want.",
  },
  {
    value: "All features",
    label:
      "including image, audio, memory, scheduling and external connectors that you'd expect from any competent agent. Plus any custom connector you build.",
  },
] as const;

export const FEATURES = {
  eyebrow: "What it can do for you",
  title: `${BRAND.name} was destined to be your perfect personal assistant.`,
  body: "So we packed in every feature and setting we could think of, and even made it open source. It'll fit right into your life.",
  cards: [
    {
      title: "The world is your stage, and you play many roles",
      body: "Your agent switches roles with you. Tell it what you care about and turn on web search, and it becomes your news reporter. Give it your diet plan and a delivery app, and it becomes your nutritionist.",
      wide: true,
    },
    {
      title: "It remembers and reminds",
      body: "Your dog's name, your coffee order, your pills at 9am. Tell it once and it messages you when it matters.",
    },
    {
      title: "Run your life",
      body: "Plan a weekend trip, compare two phones, draft the email you keep putting off. Ask it the way you'd ask a friend who knows a bit about everything.",
    },
    {
      title: "Run your business",
      body: "Let it answer customers, keep your orders in Notion and read your stock sheets. Salts is open source, so you can build a connector for any software your business runs on.",
    },
    {
      title: "It lives with you",
      body: "Message it on Telegram or WhatsApp like you would a friend. Send text, links, photos or voice notes, and it replies the same way.",
    },
    {
      title: "Share it with the world",
      body: "Add it to a Telegram group with your friends, family, clients or customers, and it answers anyone who mentions it. You choose exactly who it talks to.",
    },
  ],
  /** The one dark card at the end of the grid. */
  highlight: {
    title: "There's always more",
    body: "Host the whole project on your own Cloudflare account to run your agent without our usage limits, and with full control over it.",
  },
} as const;

export const MISSION = {
  title: `${BRAND.name} is making AI accessible for all.`,
  body: "When everyone has open and equal access to AI, people coordinate better, and resources are distributed more fairly.",
  coveragePrefix: "We've covered",
  coverageSuffix: "of the planet so far",
} as const;

export const CAPABILITIES = {
  title: "Every capability is a switch you can turn on.",
  body: "There's a switch for almost anything, and your agent can find them for you. Remember to turn off the switches when not in use.",
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
  /** Shown switched off when the page loads, so the light starts part-way. */
  offByDefault: [
    "Listen to voice notes",
    "Reply with voice notes",
    "Create images",
    "Connect to GitHub",
    "Screen candidates",
  ],
  more: "More added every day.",
} as const;

/** A short section for Fleet Accounts. Kept modest on purpose: the page is about personal agents. */
export const FLEET = {
  eyebrow: "Fleet Accounts",
  title: "Give your whole community personal agents.",
  body: "Create agents for everyone in your community. These agents can share your OpenRouter key, so they work out of the box.",
  points: [
    {
      title: "Shared API key, with individual limits",
      body: "As the admin, you control how much each person can use your API key.",
    },
    {
      title: "Customize and ease their experience",
      body: "You control which settings and capabilities your community members see. Depending on your community, you can hide a few features to make the agents easier to use.",
    },
    {
      title: "Agents stay private to their owners",
      body: "Community members still own their agents. Their conversations are never shared with other agents or with the admin.",
    },
  ],
  /** The owner in the middle of the diagram. */
  owner: {
    name: "Skipper",
    role: "Fleet Owner",
    key: "Skipper's OpenRouter API key",
  },
  /** The community around the owner; sample names only. */
  members: ["Alex", "Marty", "Gloria", "Melman", "Julien", "Kowalski", "Rico", "Private"],
  cta: "Learn about fleets",
  note: "By default, accounts are limited to 5 agents. Request an increase to your account's agent limit before creating a fleet.",
} as const;

/**
 * The three-step setup, rendered in "How it works".
 */
export const STEPS = [
  {
    n: "01",
    title: "Get an OpenRouter API key",
    body: "Get your own key by purchasing credits directly from openrouter.ai. Or use any crypto wallet to get a key from us. You can start with just $5.",
    /** The phrase in `body` that links out. */
    link: { text: "openrouter.ai", href: "https://openrouter.ai" },
  },
  {
    n: "02",
    title: "Create your agent",
    body: "Sign in and add or buy a key in your OpenRouter wallet. Then create an agent, give it a name and pick that key. That's it.",
  },
  {
    n: "03",
    title: "Discover more as you go",
    body: "Connect it to Telegram or WhatsApp, and find new capabilities and commands as you use your agent.",
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
  /** An answer can link one of its phrases out, the same way the steps do. */
  items: [
    {
      q: "Is it really free?",
      a: `Yes. Running your ${BRAND.name} agent is free, within the usage limits. You only pay for the model tokens it uses, and for any connected apps that have paid plans of their own.`,
    },
    {
      q: "What are the usage limits?",
      a: `Up to 5 agents per account, and ${SESSION_LIMIT} chat sessions and ${STORAGE_MB} MB of files per agent. Need more agents? Request a higher limit from the app, or host ${BRAND.name} yourself on Cloudflare with no limits.`,
    },
    {
      q: "Do I need an OpenRouter account?",
      a: "No. You can bring your own key from openrouter.ai, or buy one from us with any crypto wallet. Either way, every reply is paid from that key's credit, and you can switch models at any time.",
      link: { text: "openrouter.ai", href: "https://openrouter.ai" },
    },
    {
      q: "How is it different from ChatGPT or OpenClaw?",
      a: `ChatGPT charges a monthly subscription and only answers while you have it open. OpenClaw runs on your own computer, so it stops when your computer does. Your ${BRAND.name} agent runs online all the time, can message you first, and lives in the chat apps you already use.`,
    },
    {
      q: "Who can read my conversations?",
      a: "Only you, and anyone you add under Manage access. If your agent is part of a fleet, the fleet owner can see what it spends but not what you say. Your messages go through OpenRouter to the model you picked, under that company's privacy policy.",
    },
    {
      q: "What apps can it connect to?",
      a: "We offer one-click integrations for Notion, GitHub, Swiggy and a few other MCP servers we've built ourselves. You can connect any app that has a public MCP server, or one hosted by a third party. Ask your agent about an app you use.",
    },
    {
      q: "What if the app I use isn't supported?",
      a: `Open an issue on GitHub and tell us what you need. ${BRAND.name} is open source, so we and the community can help build a connector for it.`,
      link: { text: "Open an issue on GitHub", href: LINKS.githubIssues },
    },
    {
      q: "Can I send it videos?",
      a: "Not at the moment. You can send photos, screenshots, PDFs, text files and voice notes, as long as the matching capability is switched on.",
    },
    {
      q: "What happens when my credit runs out?",
      a: "Your agent stops replying until its key has credit again. Top up on OpenRouter, or buy a new key with crypto, since a bought key cannot be topped up.",
    },
    {
      q: "Do I have to use Telegram or WhatsApp?",
      a: "No. You can talk to your agent in your browser at any time, and every conversation shows up there too, wherever it started.",
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
