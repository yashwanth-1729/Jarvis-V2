"use client";

import { Check, Eye, EyeOff, Loader2, X } from "lucide-react";
import * as React from "react";

import { PROVIDER_KEY_STORAGE, getProviderKey } from "@/lib/agentBridge";
import { API_BASE, API_BASE_STORAGE_KEY, isNativeShell } from "@/lib/api";
import { clearAll } from "@/lib/localdb";
import {
  readLocation,
  reportLocation,
  setLocationByName,
  type RememberedLocation,
} from "@/lib/geo";
import { cn } from "@/lib/utils";

type ProbeState = "idle" | "checking" | "ok" | "fail";

/**
 * Where the two addresses JARVIS needs are entered.
 *
 * Both are runtime settings rather than build-time constants, for reasons that
 * only bite once the app is packaged: a phone has no devtools console to poke
 * localStorage from, a laptop's DHCP address changes, and baking a Supabase key
 * into an APK puts it in every copy of the file. Entering them here means one
 * build works against a home laptop today and a VPS later.
 */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [place, setPlace] = React.useState<RememberedLocation | null>(null);
  const [placeName, setPlaceName] = React.useState("");
  const [locating, setLocating] = React.useState(false);

  React.useEffect(() => {
    void readLocation().then(setPlace);
  }, []);

  // `force` skips the "asked recently / was refused" backoff. That backoff is
  // right for the automatic call on launch and wrong here: pressing the button
  // *is* the request, and refusing to act on it because a dialog was dismissed
  // last week would be baffling.
  const locate = async () => {
    setLocating(true);
    const found = await reportLocation(true);
    if (found) setPlace(found);
    setLocating(false);
  };

  const nameIt = async () => {
    const cleaned = placeName.trim();
    if (!cleaned) return;
    setLocating(true);
    const found = await setLocationByName(cleaned);
    if (found) {
      setPlace(found);
      setPlaceName("");
    }
    setLocating(false);
  };

  /** Read one stored setting, independent of whether the others are set.
   *  `getSupabaseConfig()` deliberately returns null unless the pair is
   *  complete — correct for deciding whether sync can run, wrong for
   *  repopulating a form, where it silently discards a half-finished entry. */
  const stored = React.useCallback((key: string) => {
    try {
      return window.localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  }, []);

  const [backend, setBackend] = React.useState(() => {
    try {
      return window.localStorage.getItem(API_BASE_STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [supabaseUrl, setSupabaseUrl] = React.useState(() => stored("jarvis.supabaseUrl"));
  const [supabaseKey, setSupabaseKey] = React.useState(() => stored("jarvis.supabaseKey"));
  const [providerKey, setProviderKey] = React.useState(() => getProviderKey());
  const [showKey, setShowKey] = React.useState(false);
  const [showProviderKey, setShowProviderKey] = React.useState(false);
  const [backendProbe, setBackendProbe] = React.useState<ProbeState>("idle");
  /** Whether the runtime currently holds a provider key, per its health. */
  const [runtimeHasKey, setRuntimeHasKey] = React.useState<boolean | null>(null);
  const [confirmReset, setConfirmReset] = React.useState(false);

  const dialogRef = React.useRef<HTMLDivElement>(null);

  // Escape closes, and focus moves in on open so a keyboard or screen-reader
  // user is not left behind on the page underneath.
  React.useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Ask the runtime whether it actually has a key. Saving one is silent
  // otherwise: a mistyped or unsaved key looks identical to a working one,
  // which is exactly how a key can appear set while the assistant stays dead.
  React.useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(5000) })
      .then((response) => (response.ok ? response.json() : null))
      .then((health) => {
        if (!cancelled) setRuntimeHasKey(health?.api_key_configured ?? null);
      })
      .catch(() => {
        if (!cancelled) setRuntimeHasKey(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Ask the runtime whether it is actually there, rather than guessing. */
  const probeBackend = React.useCallback(async () => {
    setBackendProbe("checking");
    const base = (backend.trim() || API_BASE).replace(/\/$/, "");
    try {
      const response = await fetch(`${base}/api/health`, {
        signal: AbortSignal.timeout(4000),
      });
      setBackendProbe(response.ok ? "ok" : "fail");
    } catch {
      setBackendProbe("fail");
    }
  }, [backend]);

  const save = React.useCallback(() => {
    const store = (key: string, value: string) => {
      const cleaned = value.trim().replace(/\/$/, "");
      if (cleaned) window.localStorage.setItem(key, cleaned);
      else window.localStorage.removeItem(key);
    };
    store(API_BASE_STORAGE_KEY, backend);
    store("jarvis.supabaseUrl", supabaseUrl);
    store("jarvis.supabaseKey", supabaseKey);
    store(PROVIDER_KEY_STORAGE, providerKey);
    // Reloading rather than mutating live: API_BASE is read once at module load
    // by callers across the app, so a hot change would leave half of them
    // talking to the old address.
    window.location.reload();
  }, [backend, supabaseUrl, supabaseKey, providerKey]);

  const reset = React.useCallback(async () => {
    await clearAll();
    window.location.reload();
  }, []);

  return (
    <div
      className="mobile-ui fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-0"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      {/* Scrim strong enough to isolate the sheet, and clicking it dismisses. */}
      <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-surface-0/70 backdrop-blur-sm"
      />

      <div
        ref={dialogRef}
        tabIndex={-1}
        className={cn(
          "settings-dialog relative m-0 flex max-h-[calc(100dvh-24px)] w-full max-w-lg flex-col overflow-hidden",
          "rounded-2xl border border-line bg-surface-1 sm:m-4",
          "motion-safe:animate-fade-in motion-safe:[animation-fill-mode:both] focus:outline-none",
        )}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
          <h2 id="settings-title" className="flex-1 font-display text-[20px] font-semibold text-ink">
            Connections
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="-mr-1 inline-flex h-11 w-11 items-center justify-center rounded text-ink-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <X aria-hidden className="h-4 w-4" strokeWidth={2} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4">
          {/* -- runtime ---------------------------------------------------- */}
          <section className="space-y-2">
            <label htmlFor="backend-url" className="block text-sm font-medium text-ink">
              JARVIS runtime
            </label>
            <p className="text-xs leading-relaxed text-ink-dim">
              Handles the assistant and voice. Not needed to read or edit your board.
              {isNativeShell()
                ? " On this device it is normally http://127.0.0.1:8000."
                : " Leave blank to use this page's host."}
            </p>
            <div className="flex gap-2">
              <input
                id="backend-url"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={backend}
                onChange={(event) => {
                  setBackend(event.target.value);
                  setBackendProbe("idle");
                }}
                placeholder={API_BASE}
                className="h-11 min-w-0 flex-1 rounded border border-line bg-surface-2 px-3 text-lg text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none sm:text-sm"
              />
              <button
                type="button"
                onClick={() => void probeBackend()}
                className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded border border-line px-3 text-sm text-ink-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                {backendProbe === "checking" && (
                  <Loader2 aria-hidden className="h-3.5 w-3.5 motion-safe:animate-spin" />
                )}
                {backendProbe === "ok" && <Check aria-hidden className="h-3.5 w-3.5 text-accent" />}
                Test
              </button>
            </div>
            {backendProbe !== "idle" && backendProbe !== "checking" && (
              <p
                aria-live="polite"
                className={cn("text-xs", backendProbe === "ok" ? "text-accent" : "text-critical")}
              >
                {backendProbe === "ok"
                  ? "Runtime reachable."
                  : "No runtime at that address. The board still works without it."}
              </p>
            )}

            <label className="block pt-3 text-sm font-medium text-ink">
              Location
            </label>
            <p className="text-xs leading-relaxed text-ink-dim">
              Set your city or use GPS for accurate local weather and nearby results.
            </p>
            <p className="text-xs text-ink-dim">
              Now:{" "}
              <span className="text-ink">{place ? place.label : "not known yet"}</span>
              {place && (
                <span className="text-ink-faint">
                  {" "}
                  ·{" "}
                  {place.source === "gps"
                    ? "from GPS"
                    : place.source === "manual"
                      ? "set by you"
                      : "from your network, so it may name a nearby city"}
                </span>
              )}
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                autoComplete="off"
                value={placeName}
                onChange={(event) => setPlaceName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void nameIt();
                }}
                placeholder="Type a city…"
                aria-label="Set location by name"
                className="h-11 min-w-0 flex-1 rounded border border-line bg-surface-2 px-3 text-lg text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none sm:text-sm"
              />
              <button
                type="button"
                onClick={() => void (placeName.trim() ? nameIt() : locate())}
                disabled={locating}
                className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded border border-line px-3 text-sm text-ink-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50"
              >
                {locating && (
                  <Loader2 aria-hidden className="h-3.5 w-3.5 motion-safe:animate-spin" />
                )}
                {placeName.trim() ? "Set" : "Use GPS"}
              </button>
            </div>

            <label htmlFor="provider-key" className="block pt-3 text-sm font-medium text-ink">
              Provider key
            </label>
            <p className="text-xs leading-relaxed text-ink-dim">
              Your Sarvam key. Needed for the assistant and voice; the board works
              without it. Held on this device and handed to the runtime when it
              starts.
            </p>
            <div className="relative">
              <input
                id="provider-key"
                type={showProviderKey ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={providerKey}
                onChange={(event) => setProviderKey(event.target.value)}
                placeholder="sk_..."
                className="h-11 w-full rounded border border-line bg-surface-2 px-3 pr-12 font-mono text-lg text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none sm:text-xs"
              />
              <button
                type="button"
                onClick={() => setShowProviderKey((current) => !current)}
                aria-label={showProviderKey ? "Hide provider key" : "Show provider key"}
                className="absolute right-0 top-0 inline-flex h-11 w-11 items-center justify-center text-ink-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                {showProviderKey ? (
                  <EyeOff aria-hidden className="h-4 w-4" />
                ) : (
                  <Eye aria-hidden className="h-4 w-4" />
                )}
              </button>
            </div>
            {runtimeHasKey !== null && (
              <p
                aria-live="polite"
                className={cn("text-xs", runtimeHasKey ? "text-accent" : "text-ink-dim")}
              >
                {runtimeHasKey
                  ? "The runtime has a key."
                  : "The runtime has no key yet — save to send it."}
              </p>
            )}
          </section>

          {/* -- sync ------------------------------------------------------- */}
          <section className="space-y-2 border-t border-line pt-5">
            <label htmlFor="supabase-url" className="block text-sm font-medium text-ink">
              Sync project URL
            </label>
            <p className="text-xs leading-relaxed text-ink-dim">
              Carries your board between devices. Nothing is stored here until you sync.
            </p>
            <input
              id="supabase-url"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={supabaseUrl}
              onChange={(event) => setSupabaseUrl(event.target.value)}
              placeholder="https://your-project.supabase.co"
              className="h-11 w-full rounded border border-line bg-surface-2 px-3 text-lg text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none sm:text-sm"
            />

            <label htmlFor="supabase-key" className="block pt-2 text-sm font-medium text-ink">
              Sync key
            </label>
            <div className="relative">
              <input
                id="supabase-key"
                type={showKey ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={supabaseKey}
                onChange={(event) => setSupabaseKey(event.target.value)}
                className="h-11 w-full rounded border border-line bg-surface-2 px-3 pr-12 font-mono text-lg text-ink focus:border-accent focus:outline-none sm:text-xs"
              />
              <button
                type="button"
                onClick={() => setShowKey((current) => !current)}
                aria-label={showKey ? "Hide key" : "Show key"}
                className="absolute right-0 top-0 inline-flex h-11 w-11 items-center justify-center text-ink-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                {showKey ? (
                  <EyeOff aria-hidden className="h-4 w-4" />
                ) : (
                  <Eye aria-hidden className="h-4 w-4" />
                )}
              </button>
            </div>
            <p className="text-xs leading-relaxed text-ink-dim">
              Stored on this device only, never in the app bundle.
            </p>
          </section>

          {/* -- destructive, kept apart from everything else --------------- */}
          <section className="border-t border-line pt-5">
            {confirmReset ? (
              <div className="space-y-2">
                <p className="text-xs text-ink">
                  Erase this device&rsquo;s local copy? Anything not yet synced is lost.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void reset()}
                    className="inline-flex h-11 items-center rounded bg-critical px-4 text-sm font-medium text-surface-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-critical/50"
                  >
                    Erase
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmReset(false)}
                    className="inline-flex h-11 items-center rounded border border-line px-4 text-sm text-ink-dim hover:text-ink"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmReset(true)}
                className="inline-flex h-11 items-center rounded text-sm text-critical hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-critical/50"
              >
                Erase local data
              </button>
            )}
          </section>
        </div>

        {/* The sheet is `fixed`, so it sits outside the shell's safe-area
            padding and has to inset its own footer — otherwise Save sits under
            the gesture bar, which is where a thumb naturally lands. */}
        <footer
          className={
            "flex items-center justify-end gap-2 border-t border-line px-4 py-3 " +
            "pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          }
        >
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-11 items-center rounded px-4 text-sm text-ink-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            className="inline-flex h-11 items-center rounded bg-accent px-5 text-sm font-semibold text-accent-ink hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            Save &amp; reload
          </button>
        </footer>
      </div>
    </div>
  );
}
