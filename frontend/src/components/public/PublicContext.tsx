"use client";

/**
 * The public edition's account layer (docs/public-edition.md): onboarding,
 * sign-in, the session handed to the on-device backend, and the plan, Aura and
 * features from the HOLO gateway. Mounted only in the public build
 * (lib/edition.ts); the personal app never renders it.
 */
import * as React from "react";

import "./public.css";
import "./persona.css";
import { API_BASE } from "@/lib/api";
import { deleteAccount as removeAccount, fetchMe, startLockinTrial, type Feature, type Me } from "@/lib/gateway";
import { loadProfile, type OnboardingProfile } from "@/lib/profile";
import { AUTH_CONFIGURED, loadSession, refreshSession, signOut as endSession, storeSession, type Session } from "@/lib/publicAuth";

export type PublicStage = "onboarding" | "signin" | "intro" | "app";

export interface PublicState {
  stage: PublicStage;
  session: Session | null;
  me: Me | null;
  profile: OnboardingProfile | null;
  /** Signed out on purpose ("continue without an account"). */
  offline: boolean;
  has: (feature: Feature) => boolean;
  refreshMe: () => Promise<void>;
  startTrial: () => Promise<boolean>;
  completeOnboarding: (profile: OnboardingProfile) => void;
  completeSignIn: (session: Session) => void;
  continueOffline: () => void;
  /** Back to the sign-in step after "Not now". */
  requestSignIn: () => void;
  completeIntro: () => void;
  signOut: () => Promise<void>;
  /** Delete the account on the server, then start over on this phone. */
  deleteAccount: () => Promise<void>;
  /**
   * Run onboarding again, keeping everything already on the phone (schedule,
   * tasks, Lock-in history). Only the answers are asked again.
   */
  redoSetup: () => void;
}

const PublicContext = React.createContext<PublicState | null>(null);

const OFFLINE_KEY = "jarvis.public.offline";
const INTRO_KEY = "jarvis.public.introSeen";

function flag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function setFlag(key: string, on: boolean): void {
  try {
    if (on) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // Only costs showing that step again.
  }
}

/**
 * The "her" persona (profile.gender === "female"): `html[data-persona="her"]`
 * re-tints the app (persona.css), and the Android notification cards swap
 * their gendered lines (JarvisNotifications.kt `setPersona`). Older APKs have
 * no `setPersona`; they simply keep the default lines.
 */
function applyPersona(her: boolean): void {
  const root = document.documentElement;
  if (her) root.dataset.persona = "her";
  else delete root.dataset.persona;
  try {
    const bridge = window.JarvisNotifications as unknown as { setPersona?: (value: string) => unknown } | undefined;
    if (typeof bridge?.setPersona === "function") bridge.setPersona(her ? "her" : "");
  } catch {
    // The look still changes; only the notification copy keeps its default.
  }
}

/** Hand the session to the on-device backend, which may still be booting. */
async function handToBackend(token: string, alive: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && alive(); attempt += 1) {
    try {
      const response = await fetch(`${API_BASE}/api/local/credentials`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ holo_session_token: token }),
      });
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

export function PublicProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<Session | null>(null);
  const [profile, setProfile] = React.useState<OnboardingProfile | null>(null);
  const [offline, setOffline] = React.useState(false);
  const [introSeen, setIntroSeen] = React.useState(false);
  const [me, setMe] = React.useState<Me | null>(null);
  const [ready, setReady] = React.useState(false);
  const sessionRef = React.useRef<Session | null>(null);
  sessionRef.current = session;

  React.useEffect(() => {
    setSession(loadSession());
    setProfile(loadProfile());
    setOffline(flag(OFFLINE_KEY));
    setIntroSeen(flag(INTRO_KEY));
    setReady(true);
  }, []);

  const refreshMe = React.useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    try {
      setMe(await fetchMe(current.accessToken));
    } catch {
      // Keep the last known plan; the next refresh retries.
    }
  }, []);

  // Keep the token fresh, hand it to the backend, and keep plan/Aura current.
  React.useEffect(() => {
    if (!session) {
      setMe(null);
      return;
    }
    let alive = true;
    void handToBackend(session.accessToken, () => alive);
    void refreshMe();
    const refreshIn = Math.max(session.expiresAt - Date.now() - 120_000, 5_000);
    const refreshTimer = window.setTimeout(() => {
      refreshSession(session)
        .then((next) => alive && setSession(next))
        .catch(() => {
          // A dead refresh token means signing in again.
          if (alive && Date.now() > session.expiresAt) {
            storeSession(null);
            setSession(null);
          }
        });
    }, refreshIn);
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshMe();
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // The backend may have restarted while the app was away; it keeps the
      // token in memory only.
      void handToBackend(session.accessToken, () => alive);
      void refreshMe();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearTimeout(refreshTimer);
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [session, refreshMe]);

  const startTrial = React.useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return false;
    try {
      setMe(await startLockinTrial(current.accessToken));
      return true;
    } catch {
      return false;
    }
  }, []);

  // Her persona follows the saved profile: the look now, the notification
  // cards as soon as the native bridge is attached (it can attach after load).
  const her = profile?.gender === "female";
  React.useEffect(() => {
    applyPersona(her);
    const onBridge = () => applyPersona(her);
    window.addEventListener("jarvis-native-notifications-ready", onBridge);
    return () => window.removeEventListener("jarvis-native-notifications-ready", onBridge);
  }, [her]);

  // A user who picked must-dos during onboarding gets the trial on sign-in.
  React.useEffect(() => {
    if (me && profile?.wantsLockinTrial && me.trial.lockin.available && !me.features.lockin) void startTrial();
  }, [me, profile, startTrial]);

  const value = React.useMemo<PublicState>(() => {
    const stage: PublicStage = !ready
      ? "app"
      : !profile
        ? "onboarding"
        : !session && !offline
          ? "signin"
          : !introSeen
            ? "intro"
            : "app";
    return {
      stage,
      session,
      me,
      profile,
      offline,
      has: (feature) =>
        feature === "chat" ? true : Boolean(me?.features[feature]) || (feature === "lockin" && localLockinTrial(profile)),
      refreshMe,
      startTrial,
      completeOnboarding: (next) => setProfile(next),
      completeSignIn: (next) => {
        storeSession(next);
        setFlag(OFFLINE_KEY, false);
        setOffline(false);
        setSession(next);
      },
      continueOffline: () => {
        setFlag(OFFLINE_KEY, true);
        setOffline(true);
      },
      requestSignIn: () => {
        setFlag(OFFLINE_KEY, false);
        setOffline(false);
      },
      completeIntro: () => {
        setFlag(INTRO_KEY, true);
        setIntroSeen(true);
      },
      signOut: async () => {
        await endSession(sessionRef.current);
        setSession(null);
        setMe(null);
        void handToBackend("", () => true);
      },
      redoSetup: () => {
        try {
          window.localStorage.removeItem("jarvis.public.profile");
          window.localStorage.removeItem("jarvis.public.onboarding.draft");
        } catch {
          // Storage unavailable: onboarding still opens from the state below.
        }
        setProfile(null);
      },
      deleteAccount: async () => {
        const current = sessionRef.current;
        if (current) await removeAccount(current.accessToken);
        await endSession(current);
        try {
          window.localStorage.removeItem("jarvis.public.profile");
        } catch {
          // Nothing else to clear.
        }
        setFlag(OFFLINE_KEY, false);
        setFlag(INTRO_KEY, false);
        setOffline(false);
        setIntroSeen(false);
        setSession(null);
        setMe(null);
        setProfile(null);
        void handToBackend("", () => true);
        void fetch(`${API_BASE}/api/profile`, { method: "DELETE" }).catch(() => undefined);
      },
    };
  }, [ready, profile, session, offline, introSeen, me, refreshMe, startTrial]);

  // Until the stored state is read, render nothing new: avoids flashing
  // onboarding at a returning user.
  if (!ready) return null;
  return <PublicContext.Provider value={value}>{children}</PublicContext.Provider>;
}

/** The public state, or null in the personal edition. */
/** The onboarding's 3-day Lock-in trial, kept on the device. */
export const LOCAL_TRIAL_DAYS = 3;

/**
 * The 3-day Lock-in trial onboarding promises, honoured on the device too.
 *
 * The gateway's trial (`/v1/trial/lockin`) only starts after sign-in, and
 * until the Supabase project exists nobody can sign in, so every Lock-in
 * control stayed locked (2026-10-04, the owner: "where is the start
 * button?"). Lock-in runs entirely on the device and costs no AI, so the
 * trial starts when onboarding finishes with must-dos picked, for 3 days. A
 * signed-in account's own features still win.
 */
export function localLockinTrial(profile: OnboardingProfile | null, now = Date.now()): boolean {
  if (!profile?.wantsLockinTrial || !profile.completedAt) return false;
  const started = Date.parse(profile.completedAt);
  return Number.isFinite(started) && now >= started && now - started < LOCAL_TRIAL_DAYS * 24 * 3_600_000;
}

export function usePublicOptional(): PublicState | null {
  return React.useContext(PublicContext);
}

export function usePublic(): PublicState {
  const value = React.useContext(PublicContext);
  if (!value) throw new Error("usePublic outside PublicProvider");
  return value;
}

export { AUTH_CONFIGURED };
