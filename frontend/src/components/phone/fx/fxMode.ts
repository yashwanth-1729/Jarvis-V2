"use client";

import * as React from "react";

import type { FxMode } from "./LiveBackground";

const STORAGE_KEY = "jarvis.phone.fx";
const MODES: FxMode[] = ["vivid", "wild", "calm", "off"];

/** The live background's mode, remembered on this device (Vivid by default). */
export function useFxMode() {
  const [mode, setMode] = React.useState<FxMode>("vivid");
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as FxMode | null;
      if (saved && MODES.includes(saved)) setMode(saved);
    } catch {
      /* The session choice still works. */
    }
  }, []);
  const choose = React.useCallback((next: FxMode) => {
    setMode(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* Optional persistence. */
    }
  }, []);
  return { mode, choose };
}
