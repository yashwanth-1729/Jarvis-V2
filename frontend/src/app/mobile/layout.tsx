import type { Metadata, Viewport } from "next";
import { Manrope } from "next/font/google";
import "./mobile-desk.css";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-desk", display: "swap" });

export const metadata: Metadata = {
  title: "JARVIS | Your day",
  description: "Your schedule, tasks, notes and assistant, in one place.",
};
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f1f2ef" },
    { media: "(prefers-color-scheme: dark)", color: "#202523" },
  ],
  width: "device-width", initialScale: 1, viewportFit: "cover",
};

export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return <div className={manrope.variable}>{children}</div>;
}
