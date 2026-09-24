import type { Metadata, Viewport } from "next";
import { Onest, Silkscreen, Unbounded } from "next/font/google";
import "./phone.css";

// Wide, loud display type; a clean UI face; a pixel face for tiny tags.
const display = Unbounded({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const ui = Onest({ subsets: ["latin"], variable: "--font-ui", display: "swap" });
const pixel = Silkscreen({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-pixel", display: "swap" });

export const metadata: Metadata = {
  title: "JARVIS",
  description: "Your day, your tasks, your memory and your assistant, in one place.",
};

export const viewport: Viewport = {
  themeColor: "#09090B",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${display.variable} ${ui.variable} ${pixel.variable}`}>{children}</div>;
}
