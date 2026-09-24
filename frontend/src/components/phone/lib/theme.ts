"use client";

import * as React from "react";

export type ThemeChoice = "system" | "light" | "dark";

/** The key the previous mobile design used, so a saved choice carries over. */
const STORAGE_KEY = "jarvis.mobile-desk.theme";

function systemDark(): boolean {
  return typeof matchMedia !== "function" || matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Theme preference plus the resolved light/dark value the app paints with. */
export function useTheme() {
  const [choice, setChoice] = React.useState<ThemeChoice>("system");
  const [dark, setDark] = React.useState(true);

  React.useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "light" || saved === "dark") setChoice(saved);
    } catch {
      /* The session preference still works. */
    }
  }, []);

  React.useEffect(() => {
    if (choice !== "system") {
      setDark(choice === "dark");
      return;
    }
    const query = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setDark(systemDark());
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [choice]);

  const choose = React.useCallback((next: ThemeChoice) => {
    setChoice(next);
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* Optional persistence. */
    }
  }, []);

  // The status-bar tint follows the canvas.
  React.useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])')
      ?? Object.assign(document.head.appendChild(document.createElement("meta")), { name: "theme-color" });
    meta.content = dark ? "#09090B" : "#F2F0EA";
  }, [dark]);

  return { choice, choose, dark };
}
