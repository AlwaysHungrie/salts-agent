import type { Metadata } from "next";
import {
  Bricolage_Grotesque,
  Geist,
  Geist_Mono,
  Orbitron,
  Schibsted_Grotesk,
  VT323,
} from "next/font/google";
import RainAudio from "@/components/RainAudio";
import "./globals.css";

const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
});
const schibsted = Schibsted_Grotesk({
  variable: "--font-schibsted",
  subsets: ["latin"],
});
// The front page (from mooned).
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});
const orbitron = Orbitron({
  variable: "--font-orbitron-face",
  subsets: ["latin"],
  weight: ["500", "700", "900"],
});
// The vending machine's terminal screens.
const vt323 = VT323({
  variable: "--font-vt323-face",
  subsets: ["latin"],
  weight: "400",
});

const DESCRIPTION =
  "A terminal for finding and staying in touch with the best people at Devcon VIII. Ask about anyone, or make a profile so people can find you.";

export const metadata: Metadata = {
  // Absolute URLs for the preview image; on Vercel, Next.js falls back to the deployment's own URL.
  metadataBase: process.env.SITE_URL ? new URL(process.env.SITE_URL) : undefined,
  title: "Humans at Devcon VIII",
  description: DESCRIPTION,
  openGraph: {
    title: "Humans at Devcon VIII",
    description: DESCRIPTION,
    siteName: "Humans",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Humans at Devcon VIII",
    description: DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${bricolage.variable} ${schibsted.variable} ${geistSans.variable} ${geistMono.variable} ${orbitron.variable} ${vt323.variable} h-full`}
    >
      <body className="min-h-full">
        {children}
        {/* Here rather than on a page, so the rain keeps playing from page to page. */}
        <RainAudio />
      </body>
    </html>
  );
}
