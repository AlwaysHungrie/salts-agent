import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  weight: ["300", "400", "500", "600", "700"],
});

const TITLE = "Salts — your own AI agent, always on";
const DESCRIPTION =
  "A personal AI agent that is always on and free to run. Talk to it in your browser, on Telegram or on WhatsApp. It remembers what you tell it, reminds you when things are due, and gets things done in the apps you already use.";

// Link previews need absolute URLs; the card image comes from opengraph-image.tsx.
export const metadata: Metadata = {
  metadataBase: new URL("https://salts.dev"),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: "Salts",
    type: "website",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="antialiased">
        {children}
        {/* Cloudflare Web Analytics: cookieless visitor counts. salts.dev is DNS-only on
            Cloudflare, so the beacon can't be auto-injected and lives here instead. */}
        <Script
          src="https://static.cloudflareinsights.com/beacon.min.js"
          data-cf-beacon='{"token": "baad0908ac1347658a154edfa8fd019b"}'
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
