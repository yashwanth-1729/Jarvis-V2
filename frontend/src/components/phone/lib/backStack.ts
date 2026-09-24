"use client";

import * as React from "react";

/**
 * Android's back button, wired to whatever is on top.
 *
 * The Tauri shell answers the back button with `WebView.goBack()` whenever the
 * page has history, so every layer the phone app opens (a screen, a sheet,
 * voice, chat) pushes one same-URL history entry carrying its depth. Back then
 * lands on a shallower entry, and every layer above that depth closes — the
 * way a native app peels back one screen at a time instead of quitting.
 *
 * Closing a layer from the UI (a close button, a save) rewinds its entry so
 * the history never holds a ghost that makes back appear to do nothing.
 */

interface Entry {
  id: number;
  onBack: () => void;
}

const KEY = "jarvisLayer";
const entries: Entry[] = [];
let seq = 0;
let installed = false;
/** Rewinds we started ourselves that the browser has not delivered yet. */
let rewinding = 0;
/** Pushes made while a rewind was in flight; replayed once it lands. */
let deferred = 0;

function depthOf(state: unknown): number {
  const value = (state as Record<string, unknown> | null)?.[KEY];
  return typeof value === "number" && value > 0 ? value : 0;
}

function writeEntry(depth: number) {
  window.history.pushState({ ...(window.history.state ?? {}), [KEY]: depth }, "");
}

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("popstate", (event) => {
    const depth = depthOf(event.state);
    if (rewinding > 0) {
      rewinding -= 1;
      // Anything opened while the rewind was travelling gets its entry now,
      // on top of the entry the rewind actually landed on.
      if (rewinding === 0) {
        let base = depth;
        while (deferred > 0) {
          deferred -= 1;
          base += 1;
          writeEntry(base);
        }
      }
      return;
    }
    // The user went back: close every layer above where history landed.
    while (entries.length > depth) {
      entries.pop()?.onBack();
    }
  });

  // A restart (Settings → Save) reloads with a layer entry still current.
  // Nothing is open any more, so walk back to the base entry quietly.
  const stale = depthOf(window.history.state);
  if (stale > 0) {
    rewinding += 1;
    window.history.go(-stale);
  }
}

/** Open a layer: it gets the next history entry. Returns its handle. */
export function pushLayer(onBack: () => void): number {
  install();
  const id = ++seq;
  entries.push({ id, onBack });
  if (rewinding > 0) deferred += 1;
  else writeEntry(entries.length);
  return id;
}

/** A layer closed from the UI: drop it (and anything above) and rewind. */
export function releaseLayer(id: number) {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index === -1) return; // Already closed by the back button.
  const removed = entries.splice(index);
  // Layers stacked above this one go with it.
  for (const entry of removed.slice(1).reverse()) entry.onBack();
  const pendingHere = Math.min(deferred, removed.length);
  deferred -= pendingHere;
  const toRewind = removed.length - pendingHere;
  if (toRewind > 0) {
    rewinding += 1;
    window.history.go(-toRewind);
  }
}

/**
 * Give an open layer a history entry: back closes it, and closing it from the
 * UI removes the entry again.
 */
export function useBackLayer(open: boolean, onBack: () => void) {
  const onBackRef = React.useRef(onBack);
  onBackRef.current = onBack;
  React.useEffect(() => {
    if (!open) return;
    const id = pushLayer(() => onBackRef.current());
    return () => releaseLayer(id);
  }, [open]);
}

/** Install early so a stale entry from a restart is unwound before first use. */
export function useBackStackInstall() {
  React.useEffect(() => install(), []);
}

/** How many layers are open (for tests and diagnostics). */
export function openLayers(): number {
  return entries.length;
}
