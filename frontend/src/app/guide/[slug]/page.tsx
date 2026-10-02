import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { VerifyTokenField } from "@/components/GuideFields";
import { ApiPlayground } from "@/components/guide/ApiPlayground";
import { GuideLayout } from "@/components/guide/GuideLayout";
import { Field, WhatsappCallback } from "@/components/guide/WhatsappCallback";
import { AGENT_URL } from "@/lib/agent";
import { allGuides, getGuide, neighbours } from "@/lib/guide";
import { Markdown, headingsOf } from "@/lib/guide-markdown";

/**
 * One article of the user guide, from `content/guide/<slug>.md`.
 *
 * Every page is built from its file at build time and nothing else: a slug with no
 * file is a 404, not a read of the disk at request time. So changing the guide is
 * editing a markdown file and merging it; the deploy that follows is the release.
 *
 * Ported from `landing-page/app/docs/[slug]/page.tsx`.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return allGuides().map((guide) => ({ slug: guide.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const guide = getGuide((await params).slug);
  if (!guide) return { title: "User guide — Salts" };
  return {
    title: `${guide.title} — Salts user guide`,
    description: guide.summary,
  };
}

/**
 * What a `{{name}}` line in the markdown turns into. They need a browser — one copies,
 * one invents a secret, one reads the agent id from the query string — so they are
 * elements handed to the renderer rather than anything the markdown can say.
 */
const WIDGETS = {
  "whatsapp-callback-url": (
    <Suspense fallback={<Field base={AGENT_URL} agent={null} />}>
      <WhatsappCallback base={AGENT_URL} />
    </Suspense>
  ),
  "verify-token": <VerifyTokenField />,
  "api-playground": <ApiPlayground base={AGENT_URL} />,
};

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const guide = getGuide(slug);
  if (!guide) notFound();

  const headings = headingsOf(guide.body).filter((h) => h.depth === 2);
  const { previous, next } = neighbours(slug);

  return (
    <GuideLayout current={slug}>
      <div className="flex gap-10">
        <article className="max-w-[720px] min-w-0 flex-1">
          <p className="text-faint text-xs font-semibold tracking-[0.08em] uppercase">
            {guide.section}
          </p>
          <h1 className="mt-3 text-[clamp(28px,4.5vw,40px)] leading-[1.1] font-[650] tracking-[-0.03em]">
            {guide.title}
          </h1>
          {guide.summary && (
            <p className="text-muted mt-4 text-[17px] leading-relaxed">{guide.summary}</p>
          )}

          {/* On a phone the contents sit above the article; on a wide screen the
              column on the right does the same job and this is hidden. */}
          {headings.length > 1 && (
            <nav aria-label="On this page" className="bg-canvas-soft mt-8 rounded-[20px] p-5 xl:hidden">
              <p className="text-faint text-[11px] font-semibold tracking-[0.08em] uppercase">
                On this page
              </p>
              <ul className="mt-2 space-y-1.5">
                {headings.map((h) => (
                  <li key={h.id}>
                    <a href={`#${h.id}`} className="text-muted hover:text-ink text-sm transition-colors">
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}

          <div className="mt-10">
            <Markdown source={guide.body} widgets={WIDGETS} />
          </div>

          {(previous || next) && (
            <nav className="border-hairline-soft mt-14 grid gap-3 border-t pt-8 sm:grid-cols-2">
              {previous ? (
                <Link
                  href={`/guide/${previous.slug}`}
                  className="ring-hairline-soft hover:bg-canvas-soft rounded-[16px] p-4 ring-1 transition-colors"
                >
                  <span className="text-faint text-[11px] font-semibold tracking-[0.08em] uppercase">
                    Previous
                  </span>
                  <span className="mt-1 block text-[15px] font-semibold">{previous.title}</span>
                </Link>
              ) : (
                <span />
              )}
              {next && (
                <Link
                  href={`/guide/${next.slug}`}
                  className="ring-hairline-soft hover:bg-canvas-soft rounded-[16px] p-4 text-right ring-1 transition-colors"
                >
                  <span className="text-faint text-[11px] font-semibold tracking-[0.08em] uppercase">
                    Next
                  </span>
                  <span className="mt-1 block text-[15px] font-semibold">{next.title}</span>
                </Link>
              )}
            </nav>
          )}
        </article>

        {headings.length > 1 && (
          <aside className="hidden w-[200px] shrink-0 xl:block">
            <div className="sticky top-24 py-1">
              <p className="text-faint text-[11px] font-semibold tracking-[0.08em] uppercase">
                On this page
              </p>
              <ul className="border-hairline-soft mt-3 space-y-2 border-l">
                {headings.map((h) => (
                  <li key={h.id}>
                    <a
                      href={`#${h.id}`}
                      className="text-muted hover:border-ink hover:text-ink -ml-px block border-l border-transparent pl-3 text-[13px] leading-[1.4] transition-colors"
                    >
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        )}
      </div>
    </GuideLayout>
  );
}
