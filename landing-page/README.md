# landing-page

Marketing site for Salts. Next.js 16 (App Router) + Tailwind v4 + Framer Motion. It talks
to nothing: no environment variables, no API calls.

```bash
pnpm install
pnpm dev      # http://localhost:4000
pnpm build && pnpm start
```

## Where things live

- **Copy and numbers**: `components/content.ts`. No copy lives in a component, so
  rewording the page means editing this file only. Links are in `LINKS`; one set to
  `null` renders as plain text rather than a dead link. `BROKEN-LINKS.md` tracks them.
- **Sections**: `components/sections.tsx`, placed in order by `app/page.tsx`.
- **Header highlight**: `NAV` in `content.ts`. Each nav link owns a run of section ids,
  in page order. Moving or adding a section means updating its group there too.
- **Legal pages**: `/privacy` and `/terms`, with their copy in `components/legal.ts`.
- **User guide**: not here. It lives in the web app at `/guide`.

## Design

Tokens (colors, radii, type weights) live in `app/globals.css` and mirror
`frontend/DESIGN.md`, so the site and the app read as one system. Inter stands in for
Saans at 300 / 450 / 600 / 650. Figtree is used only on the card that imitates
OpenRouter's keys screen, and JetBrains Mono for code.

## Layout notes

- **Footer reveal**: the footer is `fixed` at the viewport floor (`SiteFooter.tsx`),
  the page content is an opaque sheet above it, and an empty spacer the height of the
  footer lets the sheet scroll off and uncover it. Height is `--footer-h` in
  `globals.css`; change it in one place and both sides follow.
- **Motion**: entry reveals (`components/motion.tsx`), the header's scroll state, and
  the FAQ accordion. All of it honours `prefers-reduced-motion`.
- **Product shots**: `AppPreview.tsx`, `ApiKeysPreview.tsx` and
  `TelegramSettingsPreview.tsx` draw the app in code rather than using screenshots. A
  step in "How it works" with no visual of its own falls back to a labelled
  `<Placeholder>` block.

## Deploy

Vercel project `salts-agent-landingpage`. Merging to `main` deploys it; there is no
staging deployment. See [docs/infra.md](../docs/infra.md).
