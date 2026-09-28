import type { Metadata } from "next";
import Link from "next/link";

import { GuideLayout } from "@/components/guide/GuideLayout";
import { allGuides, guideSections } from "@/lib/guide";

/** The guide's front page: the featured articles, by section. Ported from `landing-page/app/docs/page.tsx`. */
export const metadata: Metadata = {
  title: "User guide — Salts",
  description:
    "How to set up your agent, talk to it on Telegram and WhatsApp, and run agents for other people.",
};

export default function Page() {
  const sections = guideSections({ featuredOnly: true });
  const first = allGuides()[0];

  return (
    <GuideLayout>
      <div className="max-w-[820px]">
        <p className="text-faint text-xs font-semibold tracking-[0.08em] uppercase">
          User guide
        </p>
        <h1 className="mt-3 text-[clamp(30px,5vw,44px)] leading-[1.08] font-[650] tracking-[-0.03em]">
          Create and manage your own personal AI agent.
        </h1>
        <p className="text-muted mt-5 text-[17px] leading-relaxed">
          Salts is a personal AI agent that is always online and can be accessed
          via browser, telegram or whatsapp. It is yours to customize, and does
          not need to be running on your machine or a subscription plan. You get
          to decide how your agent behaves and only pay for what you use.
        </p>
        <p className="text-muted mt-5 text-[17px] leading-relaxed">
          Salts agents do a lot more than a regular chatbot. They come with
          built-in capabilities such as web search, sending reminders,
          scheduling tasks answering with audio and support for images, URL,
          voice notes, PDFs.
        </p>
        <p className="text-muted mt-5 text-[17px] leading-relaxed">
          They can also connect to external apps such as Gmail, Notion, GitHub,
          etc. giving your agent ability to perform personalized tasks such as
          reading your emails, scheduling your calendar, and more. Reach out to
          us to if you would like us to build a feature we have not covered so
          far.
        </p>

        {first && (
          <Link
            href={`/guide/${first.slug}`}
            className="bg-ink hover:bg-ink-soft mt-7 inline-flex h-12 items-center justify-center rounded-full px-6 font-semibold text-white transition-colors"
          >
            Get Started
          </Link>
        )}

        <div className="mt-12 space-y-10">
          {sections.map((section) => (
            <section key={section.title}>
              <h2 className="text-faint text-[13px] font-semibold tracking-[0.08em] uppercase">
                {section.title}
              </h2>
              <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                {section.guides.map((guide) => (
                  <li key={guide.slug}>
                    <Link
                      href={`/guide/${guide.slug}`}
                      className="ring-hairline-soft hover:bg-canvas-soft block h-full rounded-[20px] p-5 ring-1 transition-colors"
                    >
                      <p className="text-[16px] leading-[1.3] font-semibold">
                        {guide.title}
                      </p>
                      {guide.summary && (
                        <p className="text-muted mt-2 text-[14px] leading-[1.5]">
                          {guide.summary}
                        </p>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </GuideLayout>
  );
}
