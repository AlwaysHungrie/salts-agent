import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { Inter } from "next/font/google";
import "./globals.css";

// Saans is commercial; Inter variable carries the 300/450/650 weight positions.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Salts",
  description: "Personal, Always Accessible AI Agents",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <ClerkProvider>
      <html lang="en" className={`${inter.variable} h-full antialiased`}>
        <body className="bg-canvas text-ink min-h-full flex flex-col">
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
