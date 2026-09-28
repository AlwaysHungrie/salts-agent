# Broken and unbuilt links

Audit of every destination on the landing page, as of this refactor.

All of these used to render as `href="#"`, which looks like a working link and
scrolls nowhere. They are now typed as `null` in `LINKS` in
`components/content.ts` and rendered through `<MaybeLink>`, which falls back to
plain text. **To fix one, set its value in `LINKS` — nothing else changes.**

| Key | Where it appears | Was | Status |
| --- | --- | --- | --- |
| `contact` | Footer → Company | `href="#"` | Unbuilt |

## Links that do work

| Target | Where | Note |
| --- | --- | --- |
| `signIn`, `signUp` (the web app) | Header `Sign in` and `Get my agent`, hero and closing CTA | Built |
| `guide`, `fleetGuide`, `openRouterGuide` (the app's `/guide`) | How it works, Fleet section, closing CTA, footer → Resources | Built — the user guide lives in the web app, not on this site |
| `#skills` `#how` `#costs` `#fleet` `#faq` `#mission` `#start` `#top` | Header, hero, footer | All resolve to a section that exists |
| `/privacy` `/terms` | Footer → Company | Built — `app/privacy` and `app/terms`, copy in `components/legal.ts` |

## Removed

- The signup card (`components/SignupCard.tsx`). Every CTA now links to the web app,
  where agents are created.
- The docs (`app/docs`, `content/docs`). The user guide now lives in the web app at
  `/guide`.
