import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  weight: ["300", "400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Salts — your own AI agent, always on",
  description:
    "A personal AI agent that is always on and free to run. Talk to it in your browser, on Telegram or on WhatsApp. It remembers what you tell it, reminds you when things are due, and gets things done in the apps you already use.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
