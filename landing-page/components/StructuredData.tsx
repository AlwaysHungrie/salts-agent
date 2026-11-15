import { BRAND, FAQ, HERO, LINKS } from "@/components/content";

const SITE = "https://salts.dev";

/**
 * JSON-LD for the home page: who makes Salts, what it is and what it costs, and the FAQ
 * as question and answer pairs. Search engines and AI answer engines read this to
 * describe Salts, so it repeats the page's own copy rather than adding claims.
 */
export function StructuredData() {
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${SITE}/#org`,
        name: BRAND.name,
        url: SITE,
        logo: `${SITE}/logo.png`,
        sameAs: [LINKS.github, LINKS.x, LINKS.telegram].filter(Boolean),
      },
      {
        "@type": "WebSite",
        "@id": `${SITE}/#website`,
        name: BRAND.name,
        url: SITE,
        publisher: { "@id": `${SITE}/#org` },
      },
      {
        "@type": "SoftwareApplication",
        name: BRAND.name,
        url: SITE,
        description: HERO.title.join(" ") + " " + HERO.body.filter(Boolean).join(" "),
        applicationCategory: "CommunicationApplication",
        operatingSystem: "Web, Telegram, WhatsApp",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        publisher: { "@id": `${SITE}/#org` },
      },
      {
        "@type": "FAQPage",
        mainEntity: FAQ.items.map((item) => ({
          "@type": "Question",
          name: item.q,
          acceptedAnswer: { "@type": "Answer", text: item.a },
        })),
      },
    ],
  };
  return (
    <script
      type="application/ld+json"
      // `<` escaped so no string in the data can close the script tag.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(graph).replace(/</g, "\\u003c") }}
    />
  );
}
