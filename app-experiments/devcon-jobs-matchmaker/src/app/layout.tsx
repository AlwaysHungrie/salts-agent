import type { Metadata } from "next";
import { Bricolage_Grotesque, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";

const bricolage = Bricolage_Grotesque({ variable: "--font-bricolage", subsets: ["latin"] });
const schibsted = Schibsted_Grotesk({ variable: "--font-schibsted", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Devcon Jobs",
  description: "Find your next role, or your next hire, at Devcon.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${bricolage.variable} ${schibsted.variable} h-full`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
