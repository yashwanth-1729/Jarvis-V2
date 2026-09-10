"use client";

/**
 * Tell the backend where the device is, once, quietly.
 *
 * Why this exists: asked for "the current weather" with no city named, the
 * model had a required `location` field and no way to express "here", so it
 * filled it with the literal word "current". The geocoder resolved that to an
 * island in the Bahamas and JARVIS read out those conditions to someone in
 * Nellore. Nothing errored — which is exactly why it went unnoticed.
 *
 * Three properties this deliberately has:
 *
 * 1. **It never blocks anything.** No await on the render path, no gate on
 *    startup. A denied permission, an indoor phone with no fix, or a webview
 *    that ignores geolocation entirely all end the same way: nothing happens
 *    here and the backend falls back to an IP lookup that needs no permission.
 *
 * 2. **It asks rarely.** Every `getCurrentPosition` call on Android can raise
 *    a system dialog, so a refusal is remembered and a success is not repeated
 *    for hours. An assistant that prompts for location on every launch is one
 *    people deny permanently.
 *
 * 3. **It prefers a coarse fix fast over a precise fix eventually.** Weather
 *    needs the city, not the street. `enableHighAccuracy` stays off: it wakes
 *    the GPS radio, costs battery, and can take 30s indoors to answer a
 *    question that a cell-tower fix answers in one.
 */

import { API_BASE } from "@/lib/api";

const ASKED_KEY = "jarvis.geo.lastAsk";
const DENIED_KEY = "jarvis.geo.denied";

/** Don't re-ask for six hours after a success. */
const REASK_MS = 6 * 60 * 60 * 1000;
/** After an outright refusal, leave it alone for a week. */
const RETRY_DENIED_MS = 7 * 24 * 60 * 60 * 1000;

/** Long enough for a cold cell-tower fix, short enough not to hang forever. */
const FIX_TIMEOUT_MS = 15_000;

export interface RememberedLocation {
  latitude: number;
  longitude: number;
  label: string;
  source: string;
  accuracy?: number | null;
  updated_at?: string | null;
}

function stamp(key: string): number {
  if (typeof window === "undefined") return 0;
  const raw = window.localStorage.getItem(key);
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) ? value : 0;
}

function mark(key: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, String(Date.now()));
}

function shouldAsk(): boolean {
  if (typeof window === "undefined") return false;
  if (!("geolocation" in navigator)) return false;
  if (Date.now() - stamp(DENIED_KEY) < RETRY_DENIED_MS) return false;
  return Date.now() - stamp(ASKED_KEY) >= REASK_MS;
}

function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: FIX_TIMEOUT_MS,
      // A fix from the last quarter hour is a perfectly good answer to "what
      // city am I in", and costs no radio at all.
      maximumAge: 15 * 60 * 1000,
    });
  });
}

async function push(body: Record<string, unknown>): Promise<RememberedLocation | null> {
  try {
    const response = await fetch(`${API_BASE}/api/location`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;
    return (await response.json()) as RememberedLocation;
  } catch {
    // The backend may not be up yet on a cold start. The fix is not worth
    // retrying for — the next launch will send a fresher one.
    return null;
  }
}

/**
 * Ask the platform for a fix and hand it to the backend.
 *
 * Returns null whenever nothing was sent, for any reason — asked too recently,
 * denied, unsupported, timed out. Callers are expected to ignore the result;
 * it is returned for tests and for the settings screen, which shows the user
 * what JARVIS currently thinks.
 */
export async function reportLocation(force = false): Promise<RememberedLocation | null> {
  if (typeof window === "undefined") return null;
  if (!force && !shouldAsk()) return null;
  if (!("geolocation" in navigator)) return null;

  let position: GeolocationPosition;
  try {
    position = await currentPosition();
  } catch (error) {
    const code = (error as GeolocationPositionError | undefined)?.code;
    // PERMISSION_DENIED is a decision; a timeout is just a bad moment, and
    // re-asking after one of those is reasonable.
    if (code === 1) mark(DENIED_KEY);
    return null;
  }

  mark(ASKED_KEY);
  return push({
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy: position.coords.accuracy ?? null,
  });
}

/** What the backend currently believes, without asking the device anything. */
export async function readLocation(): Promise<RememberedLocation | null> {
  try {
    const response = await fetch(`${API_BASE}/api/location`);
    if (!response.ok) return null;
    return (await response.json()) as RememberedLocation | null;
  } catch {
    return null;
  }
}

/** Set the place by hand, for when the device cannot or will not say. */
export async function setLocationByName(label: string): Promise<RememberedLocation | null> {
  const cleaned = label.trim();
  if (!cleaned) return null;
  try {
    const response = await fetch(`${API_BASE}/api/location/name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: cleaned }),
    });
    if (!response.ok) return null;
    return (await response.json()) as RememberedLocation;
  } catch {
    return null;
  }
}
