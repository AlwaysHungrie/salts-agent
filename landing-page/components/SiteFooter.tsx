import { BRAND, FOOTER } from "./content";
import { MaybeLink, Wrap } from "./ui";

/**
 * Fixed to the viewport floor. The page sheet scrolls up off it, so the footer
 * is uncovered rather than scrolled into — see the spacer in app/page.tsx.
 *
 * Copy and link targets live in ./content.ts.
 */
/** The Company column's icon links and text links, reused by the phone layout. */
const COMPANY = FOOTER.columns.find((c) => "social" in c);
const SOCIAL = COMPANY && "social" in COMPANY ? COMPANY.social : [];
const LEGAL = COMPANY?.links ?? [];

export function SiteFooter() {
  return (
    <footer className="fixed inset-x-0 bottom-0 z-0 flex h-(--footer-h) flex-col justify-between bg-ink pt-10 pb-6 text-white sm:pt-12 sm:pb-8">
      <Wrap>
        <div className="grid gap-7 sm:gap-8 md:grid-cols-[2fr_1fr_1fr_1fr]">
          <div>
            <div className="flex items-center justify-between gap-2.5">
              <div className="flex items-center gap-2.5">
              {/* Same dark tile as the header; a lift and a hairline keep it off the ink. */}
              <span className="grid size-8 place-items-center rounded-[10px] bg-ink-soft ring-1 ring-inset ring-white/14 shadow-[0_1px_0_0_rgba(255,255,255,0.06)_inset]">
                <span className="grid grid-cols-2 gap-0.75">
                  <span className="size-1.25 rounded-[1.5px] bg-white" />
                  <span className="size-1.25 rounded-[1.5px] bg-white/45" />
                  <span className="size-1.25 rounded-[1.5px] bg-white/45" />
                  <span className="size-1.25 rounded-[1.5px] bg-white" />
                </span>
              </span>
              <span className="text-[17px] font-[650] tracking-[-0.02em]">
                {BRAND.name}
              </span>
              </div>
              {/* On a phone the icons sit beside the name; wider, in Company. */}
              <div className="flex items-center gap-4 sm:hidden">
                {SOCIAL.map((l) => (
                  <MaybeLink
                    key={l.icon}
                    href={l.href}
                    className="text-faint transition-colors hover:text-white"
                  >
                    <SocialIcon icon={l.icon} />
                    <span className="sr-only">{l.label}</span>
                  </MaybeLink>
                ))}
              </div>
            </div>
            <p className="mt-3 max-w-[320px] text-[13px] leading-relaxed text-faint sm:text-sm">
              {FOOTER.tagline}
            </p>
          </div>

          {/* Two-up on a narrow screen; md:contents returns them to the
              four-column grid above. */}
          <div className="mt-3 sm:mt-0 grid grid-cols-2 gap-x-4 gap-y-7 md:contents">
            {FOOTER.columns.map((col) => (
              // Company folds into the bottom row on a phone.
              <div key={col.title} className={"social" in col ? "hidden sm:block" : ""}>
                <h4 className="text-xs font-semibold uppercase tracking-[0.08em] text-faint">
                  {col.title}
                </h4>
                {"social" in col && (
                  <div className="mt-4 mb-5 flex items-center gap-3">
                    {col.social.map((l) => (
                      <MaybeLink
                        key={l.icon}
                        href={l.href}
                        className="text-faint transition-colors hover:text-white"
                      >
                        <SocialIcon icon={l.icon} />
                        <span className="sr-only">{l.label}</span>
                      </MaybeLink>
                    ))}
                  </div>
                )}
                <ul className="mt-3 sm:space-y-2">
                  {col.links.map((l) => (
                    <li key={l.label}>
                      <MaybeLink
                        href={l.href}
                        className="text-sm text-faint transition-colors hover:text-white"
                      >
                        {l.label}
                      </MaybeLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </Wrap>

      <Wrap>
        <div className="flex items-center justify-between border-t border-white/12 pt-5 text-xs text-faint sm:hidden">
          <span>
            © {BRAND.year} {BRAND.legalName}
          </span>
          <span className="flex gap-4">
            {LEGAL.map((l) => (
              <MaybeLink key={l.label} href={l.href} className="transition-colors hover:text-white">
                {l.label}
              </MaybeLink>
            ))}
          </span>
        </div>
        <div className="hidden sm:flex flex-col gap-3 border-t border-white/12 pt-5 text-xs text-faint sm:flex-row sm:items-center sm:justify-between">
          <span>
            © {BRAND.year} {BRAND.legalName}
          </span>
          <span>{FOOTER.note}</span>
        </div>
      </Wrap>
    </footer>
  );
}

function SocialIcon({ icon }: { icon: "x" | "telegram" }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-[18px] fill-current">
      {icon === "x" ? (
        <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
      ) : (
        <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
      )}
    </svg>
  );
}
