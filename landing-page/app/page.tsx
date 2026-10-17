import { FaqSection } from "@/components/Faq";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import {
  Capabilities,
  Costs,
  Cta,
  Features,
  Fleet,
  Hero,
  Mission,
  Stats,
  Steps,
} from "@/components/sections";

/**
 * Section order matters twice over: it's the reading order, and it's what the
 * header highlight walks through. Every section below carries an id that is
 * listed in a NAV group in components/content.ts — add a section, add its id
 * to the group it belongs to, and the highlight stays unbroken.
 */
export default function Page() {
  return (
    <>
      <SiteHeader />

      {/* The sheet: opaque, above the footer, rounded where it lifts off it. */}
      <div id="top" className="relative z-10 rounded-b-[32px] bg-canvas">
        <main>
          <Hero />
          <Stats />
          <Features />
          <Capabilities />
          <Steps />
          <Costs />
          <Mission />
          <Fleet />
          <FaqSection />
          <Cta />
        </main>
      </div>

      {/* Scrolling past the sheet uncovers the fixed footer underneath. */}
      <div aria-hidden className="h-[var(--footer-h)]" />
      <SiteFooter />
    </>
  );
}
