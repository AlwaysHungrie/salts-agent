import type { Metadata } from "next";

import { LegalPage } from "@/components/LegalPage";
import { BRAND } from "@/components/content";
import { PRIVACY } from "@/components/legal";

export const metadata: Metadata = {
  title: `${PRIVACY.title} — ${BRAND.name}`,
  description: `What ${BRAND.name} collects when you use it, why, and how to have it deleted.`,
};

export default function Page() {
  return <LegalPage doc={PRIVACY} />;
}
