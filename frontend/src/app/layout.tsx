import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";

import "./globals.css";

/**
 * Tri-stack, self-hosted by next/font (no render-blocking request, no FOIT):
 *   Space Grotesk — brand + view titles. Gives the product an identity that a
 *                   single-family Inter system cannot.
 *   Inter         — all UI and prose.
 *   JetBrains Mono— every number, timestamp, ID, key and tool name.
 */
const grotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-grotesk",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "JARVIS — Command Center",
  description:
    "Persistent AI personal command center: tasks, schedule, ideas and memory.",
};

export const viewport: Viewport = {
  themeColor: "#0A0908",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${inter.variable} ${grotesk.variable} ${mono.variable}`}
    >
      <body className="h-full overflow-hidden font-sans">{children}</body>
    </html>
  );
}
