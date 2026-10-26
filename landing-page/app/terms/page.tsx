import type { Metadata } from "next";

import { LegalPage } from "@/components/LegalPage";
import { BRAND } from "@/components/content";
import { TERMS } from "@/components/legal";

export const metadata: Metadata = {
  title: `${TERMS.title} — ${BRAND.name}`,
  description: `The terms you agree to when you use ${BRAND.name}.`,
};

export default function Page() {
  return <LegalPage doc={TERMS} />;
}
