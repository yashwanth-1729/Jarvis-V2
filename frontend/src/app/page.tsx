import { Onest, Silkscreen, Unbounded } from "next/font/google";

import { DesktopApp } from "@/components/desktop/DesktopApp";
import "./mobile/phone.css";
import "@/components/desktop/desktop.css";

// The phone's type, so the desktop app looks the same: wide, loud display
// type; a clean UI face; a pixel face for tiny tags.
const display = Unbounded({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const ui = Onest({ subsets: ["latin"], variable: "--font-ui", display: "swap" });
const pixel = Silkscreen({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-pixel", display: "swap" });

/**
 * The desktop app: the phone's design arranged for a wide window
 * (components/desktop). The previous desktop interface lives at /classic/.
 */
export default function DesktopPage() {
  return (
    <div className={`${display.variable} ${ui.variable} ${pixel.variable}`}>
      <DesktopApp />
    </div>
  );
}
