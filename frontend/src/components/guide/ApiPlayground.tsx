"use client";

import "@scalar/api-reference-react/style.css";
import dynamic from "next/dynamic";

/**
 * The agent API, read from the Worker's own `/openapi.json` and drawn with a "Test
 * request" button on every route. The document is generated from the Worker's route
 * schemas, so nothing here lists a route by hand.
 *
 * Requests go from the browser straight to the Worker (`base`, handed in by the server),
 * carrying the API key the reader pastes in. The key is not remembered between visits.
 */
const Reference = dynamic(
  () => import("@scalar/api-reference-react").then((m) => m.ApiReferenceReact),
  {
    ssr: false,
    loading: () => <p className="text-muted text-sm">Loading the API…</p>,
  },
);

export function ApiPlayground({ base }: { base: string }) {
  return (
    <div className="border-hairline-soft my-6 overflow-hidden rounded-[20px] border">
      <Reference
        configuration={{
          url: `${base}/openapi.json`,
          layout: "modern",
          showSidebar: false,
          hideDarkModeToggle: true,
          withDefaultFonts: false,
          authentication: { preferredSecurityScheme: "apiKey" },
          // Scalar's own tooling and AI chat: nothing a reader of this guide needs.
          showDeveloperTools: "never",
          agent: { disabled: true },
        }}
      />
    </div>
  );
}
