"use client";

import { ConnectorsSection } from "@/components/ConnectorsSection";
import { ArrowLeft, Check, Eye, EyeOff, Loader2, X } from "lucide-react";
import * as React from "react";
import { SettingsHome, SETTINGS_PAGES, type SettingsPage } from "./mobile-desk/SettingsHome";
import { createLinearSlide } from "./mobile-desk/linearSlide";

import {
  GEMINI_KEY_STORAGE,
  OPENROUTER_KEY_STORAGE,
  PROVIDER_KEY_STORAGE,
  getGeminiKey,
  getOpenRouterKey,
  getProviderKey,
} from "@/lib/agentBridge";
import { API_BASE, API_BASE_STORAGE_KEY, isNativeShell } from "@/lib/api";
import { clearAll } from "@/lib/localdb";
import {
  readLocation,
  reportLocation,
  setLocationByName,
  type RememberedLocation,
} from "@/lib/geo";
import {
  applyRecoveryCode,
  generateNewIdentity,
  getSldtSettings,
  getSyncBackend,
  hasSessionSecret,
  setSessionSecret,
  setSldtSettings,
  setSyncBackend,
  type SldtWriteMode,
  type SyncBackend,
} from "@/lib/sldtConfig";
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
export function SettingsPanel({ onClose, appearance, presentation = "dialog" }: { onClose: () => void; appearance?: React.ReactNode; presentation?: "dialog" | "pocket" }) {
  const pocket = presentation === "pocket";
  const [page, setPage] = React.useState<SettingsPage | null>(null);
  // Retain outgoing detail content until the next category opens.
  const [category, setCategory] = React.useState<SettingsPage>("appearance");
  const show = (id: SettingsPage) => !pocket || category === id;
  const openPage = (id: SettingsPage) => { setCategory(id); setPage(id); };
  const pageRef = React.useRef(page);
  pageRef.current = page;
  const settingsTrack = React.useRef<HTMLDivElement>(null);
  const detailRef = React.useRef<HTMLDivElement | null>(null);
  const settingsHeading = React.useRef<HTMLHeadingElement>(null);
  const settingsSlide = React.useRef<ReturnType<typeof createLinearSlide> | null>(null);
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

  // -- SLDT (open-source sync alternative to Supabase) -------------------
  const [syncBackend, setSyncBackendChoice] = React.useState<SyncBackend>(() => getSyncBackend());
  const [sldtDatasetId, setSldtDatasetId] = React.useState(() => getSldtSettings()?.datasetId ?? "");
  const [sldtRepo, setSldtRepo] = React.useState(() => getSldtSettings()?.repo ?? "");
  const [sldtBranch, setSldtBranch] = React.useState(() => getSldtSettings()?.branch ?? "main");
  const [sldtPathPrefix, setSldtPathPrefix] = React.useState(() => getSldtSettings()?.pathPrefix ?? "sldt/");
  const [sldtWriteMode, setSldtWriteMode] = React.useState<SldtWriteMode>(
    () => getSldtSettings()?.writeMode ?? "direct",
  );
  const [sldtProxyUrl, setSldtProxyUrl] = React.useState(() => getSldtSettings()?.proxyUrl ?? "");
  const [sldtDirectToken, setSldtDirectToken] = React.useState(() => getSldtSettings()?.directToken ?? "");
  const [showSldtToken, setShowSldtToken] = React.useState(false);
  const [sldtUnlocked, setSldtUnlocked] = React.useState(() => hasSessionSecret());
  const [sldtRecoveryInput, setSldtRecoveryInput] = React.useState("");
  const [sldtNewRecoveryCode, setSldtNewRecoveryCode] = React.useState<string | null>(null);
  const [sldtError, setSldtError] = React.useState<string | null>(null);

  /** First-time setup: a brand new dataset. The code is shown once -- there is no way to recover it later, so it stays on screen until the user dismisses it themselves. */
  const generateSldtIdentity = React.useCallback(() => {
    const { identity, recoveryCode } = generateNewIdentity();
    setSessionSecret(identity.secret);
    setSldtDatasetId(identity.datasetId);
    setSldtNewRecoveryCode(recoveryCode);
    setSldtUnlocked(true);
    setSldtError(null);
  }, []);

  /** Joining a dataset an existing device already created. */
  const pairSldtRecoveryCode = React.useCallback(() => {
    try {
      const { datasetId } = applyRecoveryCode(sldtRecoveryInput);
      setSldtDatasetId(datasetId);
      setSldtUnlocked(true);
      setSldtRecoveryInput("");
      setSldtError(null);
    } catch {
      setSldtError("That doesn't look like a valid recovery code (expected SLDT:<id>:<secret>).");
    }
  }, [sldtRecoveryInput]);
  const [providerKey, setProviderKey] = React.useState(() => getProviderKey());
  const [geminiKey, setGeminiKey] = React.useState(() => getGeminiKey());
  const [openrouterKey, setOpenrouterKey] = React.useState(() => getOpenRouterKey());
  const [showKey, setShowKey] = React.useState(false);
  const [showProviderKey, setShowProviderKey] = React.useState(false);
  const [showGeminiKey, setShowGeminiKey] = React.useState(false);
  const [showOpenRouterKey, setShowOpenRouterKey] = React.useState(false);
  const [backendProbe, setBackendProbe] = React.useState<ProbeState>("idle");
  /** Whether the runtime currently holds a provider key, per its health. */
  const [runtimeHasKey, setRuntimeHasKey] = React.useState<boolean | null>(null);
  const [runtimeHasGeminiKey, setRuntimeHasGeminiKey] = React.useState<boolean | null>(null);
  const [runtimeHasOpenRouterKey, setRuntimeHasOpenRouterKey] = React.useState<boolean | null>(null);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const draft = JSON.stringify([backend, supabaseUrl, supabaseKey, providerKey, geminiKey, openrouterKey, syncBackend, sldtDatasetId, sldtRepo, sldtBranch, sldtPathPrefix, sldtWriteMode, sldtProxyUrl, sldtDirectToken]);
  const originalDraft = React.useRef(draft);
  const dirty = draft !== originalDraft.current;

  const dialogRef = React.useRef<HTMLDivElement>(null);

  // Escape closes, and focus moves in on open so a keyboard or screen-reader
  // user is not left behind on the page underneath.
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (pocket && pageRef.current) setPage(null);
        else onClose();
      }
      if (event.key === "Tab") {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') || []).filter(element => !element.closest('[hidden], [inert]') && element.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); if (previous?.isConnected) previous.focus(); };
  }, [onClose, pocket]);

  React.useLayoutEffect(() => {
    if (!pocket || !settingsTrack.current) return;
    const controller = createLinearSlide([{ element: settingsTrack.current, percent: -100 }], 0);
    settingsSlide.current = controller;
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const settle = () => { if (preference.matches || document.hidden) controller.move(pageRef.current ? 1 : 0, true); };
    preference.addEventListener("change", settle);
    document.addEventListener("visibilitychange", settle);
    return () => { controller.dispose(); settingsSlide.current = null; preference.removeEventListener("change", settle); document.removeEventListener("visibilitychange", settle); };
  }, [pocket]);
  React.useLayoutEffect(() => {
    if (!pocket) return;
    settingsSlide.current?.move(page ? 1 : 0, matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (page) detailRef.current?.scrollTo({ top: 0 });
    settingsHeading.current?.focus({ preventScroll: true });
  }, [page, pocket]);

  // Ask the runtime whether it actually has a key. Saving one is silent
  // otherwise: a mistyped or unsaved key looks identical to a working one,
  // which is exactly how a key can appear set while the assistant stays dead.
  React.useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(5000) })
      .then((response) => (response.ok ? response.json() : null))
      .then((health) => {
        if (!cancelled) {
          setRuntimeHasKey(health?.api_key_configured ?? null);
          setRuntimeHasGeminiKey(health?.gemini_key_configured ?? null);
          setRuntimeHasOpenRouterKey(health?.openrouter_key_configured ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRuntimeHasKey(null);
          setRuntimeHasGeminiKey(null);
          setRuntimeHasOpenRouterKey(null);
        }
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
    store(GEMINI_KEY_STORAGE, geminiKey);
    store(OPENROUTER_KEY_STORAGE, openrouterKey);

    setSyncBackend(syncBackend);
    // Only saved once a dataset actually exists (generated or paired this
    // session, or a prior session's) -- selecting "SLDT" alone with nothing
    // set up yet must not write a half-complete config that buildSldtRemote
    // would then treat as configured-but-broken.
    if (syncBackend === "sldt" && sldtDatasetId) {
      setSldtSettings({
        datasetId: sldtDatasetId,
        repo: sldtRepo.trim(),
        branch: sldtBranch.trim() || "main",
        pathPrefix: sldtPathPrefix.trim() || "sldt/",
        writeMode: sldtWriteMode,
        proxyUrl: sldtWriteMode === "proxy" ? sldtProxyUrl.trim() : null,
        directToken: sldtWriteMode === "direct" ? sldtDirectToken.trim() : null,
      });
    }
    // The session secret itself lives in sessionStorage already (see
    // sldtConfig.ts) -- nothing further to persist for it here, and a
    // reload deliberately does NOT clear it (only closing the tab/app does).

    // Reloading rather than mutating live: API_BASE is read once at module load
    // by callers across the app, so a hot change would leave half of them
    // talking to the old address.
    window.location.reload();
  }, [
    backend,
    supabaseUrl,
    supabaseKey,
    providerKey,
    geminiKey,
    openrouterKey,
    syncBackend,
    sldtDatasetId,
    sldtRepo,
    sldtBranch,
    sldtPathPrefix,
    sldtWriteMode,
    sldtProxyUrl,
    sldtDirectToken,
  ]);

  const reset = React.useCallback(async () => {
    await clearAll();
    window.location.reload();
  }, []);

  return (
    <div
      className={cn("mobile-ui fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-0", pocket && "pocket-settings")}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      {/* Scrim strong enough to isolate the sheet, and clicking it dismisses. */}
      {!pocket && <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-surface-0/70 backdrop-blur-sm"
      />}

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
          {pocket && <button className="desk-icon-button glass" aria-label={page ? "Back to settings" : "Close settings"} onClick={() => page ? setPage(null) : onClose()}><ArrowLeft size={21} /></button>}
          <h2 ref={settingsHeading} tabIndex={-1} id="settings-title" className="flex-1 font-display text-[20px] font-semibold text-ink">
            {pocket ? (page ? SETTINGS_PAGES.find(item => item.id === page)?.title : "Settings") : "Connections"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className={cn("-mr-1 inline-flex h-11 w-11 items-center justify-center rounded text-ink-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50", pocket && "pocket-settings-close")}
          >
            <X aria-hidden className="h-4 w-4" strokeWidth={2} />
          </button>
        </header>

        <div className={pocket ? "pocket-settings-viewport" : "contents"}>
        <div ref={settingsTrack} className={pocket ? "pocket-settings-track" : "contents"}>
          {pocket && <div className="pocket-settings-page" aria-hidden={!!page} ref={element => { if (element) element.inert = !!page; }}><SettingsHome onOpen={openPage} /></div>}
        <div ref={element => { detailRef.current = element; if (element) element.inert = pocket && !page; }} aria-hidden={pocket && !page ? true : undefined} className={cn("min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4", pocket && "pocket-settings-page pocket-settings-detail")}>
          <section hidden={!show("appearance")} className="pocket-setting-section">{appearance}{pocket && <p className="pocket-setting-help">Follows this device’s theme when System is selected. Changes apply immediately.</p>}</section>
          {/* -- runtime ---------------------------------------------------- */}
          <section hidden={!show("runtime")} className="pocket-setting-section space-y-2">
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

          </section>
          <section hidden={!show("location")} className="pocket-setting-section space-y-2">
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

          </section>
          <section hidden={!show("providers")} className="pocket-setting-section space-y-2">
            <label htmlFor="provider-key" className="block pt-3 text-sm font-medium text-ink">
              {pocket ? "Sarvam API key" : "Provider key"}
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

            <label htmlFor="gemini-key" className="block pt-3 text-sm font-medium text-ink">
              Gemini key <span className="font-normal text-ink-faint">(optional)</span>
            </label>
            <p className="text-xs leading-relaxed text-ink-dim">
              Bring your own Google Gemini key to use it for English chat, with
              Sarvam as the automatic fallback. Leave blank to stay on Sarvam
              for everything — nothing else changes.
            </p>
            <div className="relative">
              <input
                id="gemini-key"
                type={showGeminiKey ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={geminiKey}
                onChange={(event) => setGeminiKey(event.target.value)}
                placeholder="AIza..."
                className="h-11 w-full rounded border border-line bg-surface-2 px-3 pr-12 font-mono text-lg text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none sm:text-xs"
              />
              <button
                type="button"
                onClick={() => setShowGeminiKey((current) => !current)}
                aria-label={showGeminiKey ? "Hide Gemini key" : "Show Gemini key"}
                className="absolute right-0 top-0 inline-flex h-11 w-11 items-center justify-center text-ink-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                {showGeminiKey ? (
                  <EyeOff aria-hidden className="h-4 w-4" />
                ) : (
                  <Eye aria-hidden className="h-4 w-4" />
                )}
              </button>
            </div>
            {runtimeHasGeminiKey !== null && (
              <p
                aria-live="polite"
                className={cn("text-xs", runtimeHasGeminiKey ? "text-accent" : "text-ink-dim")}
              >
                {runtimeHasGeminiKey
                  ? "The runtime has a Gemini key."
                  : "The runtime has no Gemini key yet — save to send it."}
              </p>
            )}

            <label htmlFor="openrouter-key" className="block pt-3 text-sm font-medium text-ink">
              OpenRouter key
            </label>
            <p className="text-xs leading-relaxed text-ink-dim">
              Powers the cloud voice stack — chat, speech recognition, and
              English/Hindi/Telugu speech all go through OpenRouter now.
              Required for voice to work at all on this device (no `.env`
              ships here, so this is the only way to hand it over).
            </p>
            <div className="relative">
              <input
                id="openrouter-key"
                type={showOpenRouterKey ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={openrouterKey}
                onChange={(event) => setOpenrouterKey(event.target.value)}
                placeholder="sk-or-v1-..."
                className="h-11 w-full rounded border border-line bg-surface-2 px-3 pr-12 font-mono text-lg text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none sm:text-xs"
              />
              <button
                type="button"
                onClick={() => setShowOpenRouterKey((current) => !current)}
                aria-label={showOpenRouterKey ? "Hide OpenRouter key" : "Show OpenRouter key"}
                className="absolute right-0 top-0 inline-flex h-11 w-11 items-center justify-center text-ink-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                {showOpenRouterKey ? (
                  <EyeOff aria-hidden className="h-4 w-4" />
                ) : (
                  <Eye aria-hidden className="h-4 w-4" />
                )}
              </button>
            </div>
            {runtimeHasOpenRouterKey !== null && (
              <p
                aria-live="polite"
                className={cn("text-xs", runtimeHasOpenRouterKey ? "text-accent" : "text-ink-dim")}
              >
                {runtimeHasOpenRouterKey
                  ? "The runtime has an OpenRouter key."
                  : "The runtime has no OpenRouter key yet — save to send it."}
              </p>
            )}
          </section>

          {/* -- sync ------------------------------------------------------- */}
          <section hidden={!show("sync")} className="pocket-setting-section space-y-2 border-t border-line pt-5">
            <label className="block text-sm font-medium text-ink">Sync backend</label>
            <p className="text-xs leading-relaxed text-ink-dim">
              Carries your board between devices. Nothing is stored here until you sync.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSyncBackendChoice("supabase")}
                className={cn(
                  "h-11 flex-1 rounded border px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
                  syncBackend === "supabase"
                    ? "border-accent bg-accent/10 text-ink"
                    : "border-line text-ink-dim hover:text-ink",
                )}
              >
                Supabase
              </button>
              <button
                type="button"
                onClick={() => setSyncBackendChoice("sldt")}
                className={cn(
                  "h-11 flex-1 rounded border px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
                  syncBackend === "sldt"
                    ? "border-accent bg-accent/10 text-ink"
                    : "border-line text-ink-dim hover:text-ink",
                )}
              >
                SLDT (GitHub)
              </button>
            </div>

            {syncBackend === "supabase" ? (
              <>
                <label htmlFor="supabase-url" className="block pt-2 text-sm font-medium text-ink">
                  Sync project URL
                </label>
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
              </>
            ) : (
              <div className="space-y-2">
                <p className="text-xs leading-relaxed text-ink-dim">
                  No account, no server you run yourself required for reads — your
                  board syncs as encrypted objects in a GitHub repo you own. See{" "}
                  <span className="font-mono">jarvis-oss/sldt/README.md</span> for how
                  it works.
                </p>

                {sldtNewRecoveryCode ? (
                  <div className="space-y-2 rounded border border-accent/40 bg-accent/5 p-3">
                    <p className="text-xs font-medium text-ink">
                      Save this recovery code now — it is the only way back into this
                      account, and it cannot be shown again.
                    </p>
                    <code className="block break-all rounded bg-surface-2 p-2 text-xs text-ink">
                      {sldtNewRecoveryCode}
                    </code>
                    <button
                      type="button"
                      onClick={() => setSldtNewRecoveryCode(null)}
                      className="inline-flex h-9 items-center rounded border border-line px-3 text-xs text-ink-dim hover:text-ink"
                    >
                      I&rsquo;ve saved it
                    </button>
                  </div>
                ) : sldtUnlocked ? (
                  <p className="text-xs text-accent">
                    Unlocked for this session (dataset {sldtDatasetId.slice(0, 8)}&hellip;).
                  </p>
                ) : sldtDatasetId ? (
                  <div className="space-y-2">
                    <p className="text-xs text-ink-dim">
                      This device knows the dataset but needs its recovery code again —
                      it is never stored, by design.
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        value={sldtRecoveryInput}
                        onChange={(event) => setSldtRecoveryInput(event.target.value)}
                        placeholder="SLDT:..."
                        className="h-11 min-w-0 flex-1 rounded border border-line bg-surface-2 px-3 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={pairSldtRecoveryCode}
                        className="inline-flex h-11 shrink-0 items-center rounded border border-line px-3 text-sm text-ink-dim hover:text-ink"
                      >
                        Unlock
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={generateSldtIdentity}
                        className="inline-flex h-11 flex-1 items-center justify-center rounded border border-line text-sm text-ink-dim hover:text-ink"
                      >
                        Create new dataset
                      </button>
                    </div>
                    <p className="text-center text-xs text-ink-faint">or, if another device already made one</p>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        value={sldtRecoveryInput}
                        onChange={(event) => setSldtRecoveryInput(event.target.value)}
                        placeholder="SLDT:..."
                        className="h-11 min-w-0 flex-1 rounded border border-line bg-surface-2 px-3 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={pairSldtRecoveryCode}
                        className="inline-flex h-11 shrink-0 items-center rounded border border-line px-3 text-sm text-ink-dim hover:text-ink"
                      >
                        Pair
                      </button>
                    </div>
                  </div>
                )}
                {sldtError && <p className="text-xs text-critical">{sldtError}</p>}

                <label htmlFor="sldt-repo" className="block pt-2 text-sm font-medium text-ink">
                  GitHub repo
                </label>
                <input
                  id="sldt-repo"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={sldtRepo}
                  onChange={(event) => setSldtRepo(event.target.value)}
                  placeholder="yourname/sldt-storage"
                  className="h-11 w-full rounded border border-line bg-surface-2 px-3 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                />

                <div className="flex gap-2 pt-2">
                  <div className="flex-1 space-y-1">
                    <label htmlFor="sldt-branch" className="block text-xs font-medium text-ink">
                      Branch
                    </label>
                    <input
                      id="sldt-branch"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={sldtBranch}
                      onChange={(event) => setSldtBranch(event.target.value)}
                      className="h-10 w-full rounded border border-line bg-surface-2 px-3 font-mono text-xs text-ink focus:border-accent focus:outline-none"
                    />
                  </div>
                  <div className="flex-1 space-y-1">
                    <label htmlFor="sldt-prefix" className="block text-xs font-medium text-ink">
                      Path prefix
                    </label>
                    <input
                      id="sldt-prefix"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={sldtPathPrefix}
                      onChange={(event) => setSldtPathPrefix(event.target.value)}
                      className="h-10 w-full rounded border border-line bg-surface-2 px-3 font-mono text-xs text-ink focus:border-accent focus:outline-none"
                    />
                  </div>
                </div>

                <label className="block pt-2 text-sm font-medium text-ink">How this device writes</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSldtWriteMode("direct")}
                    className={cn(
                      "h-10 flex-1 rounded border px-2 text-xs font-medium",
                      sldtWriteMode === "direct"
                        ? "border-accent bg-accent/10 text-ink"
                        : "border-line text-ink-dim hover:text-ink",
                    )}
                  >
                    Direct (desktop/Android)
                  </button>
                  <button
                    type="button"
                    onClick={() => setSldtWriteMode("proxy")}
                    className={cn(
                      "h-10 flex-1 rounded border px-2 text-xs font-medium",
                      sldtWriteMode === "proxy"
                        ? "border-accent bg-accent/10 text-ink"
                        : "border-line text-ink-dim hover:text-ink",
                    )}
                  >
                    Through a proxy (web)
                  </button>
                </div>

                {sldtWriteMode === "direct" ? (
                  <>
                    <label htmlFor="sldt-token" className="block pt-2 text-sm font-medium text-ink">
                      GitHub token
                    </label>
                    <p className="text-xs leading-relaxed text-ink-dim">
                      A fine-grained PAT scoped to just this repo, Contents: Read and
                      write. Stored on this device only — the same trust level this
                      app already gives a Supabase key here.
                    </p>
                    <div className="relative">
                      <input
                        id="sldt-token"
                        type={showSldtToken ? "text" : "password"}
                        autoComplete="off"
                        spellCheck={false}
                        value={sldtDirectToken}
                        onChange={(event) => setSldtDirectToken(event.target.value)}
                        placeholder="github_pat_..."
                        className="h-11 w-full rounded border border-line bg-surface-2 px-3 pr-12 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowSldtToken((current) => !current)}
                        aria-label={showSldtToken ? "Hide token" : "Show token"}
                        className="absolute right-0 top-0 inline-flex h-11 w-11 items-center justify-center text-ink-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                      >
                        {showSldtToken ? (
                          <EyeOff aria-hidden className="h-4 w-4" />
                        ) : (
                          <Eye aria-hidden className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <label htmlFor="sldt-proxy" className="block pt-2 text-sm font-medium text-ink">
                      Proxy URL
                    </label>
                    <p className="text-xs leading-relaxed text-ink-dim">
                      Where jarvis-oss/proxy is deployed — it holds the GitHub token
                      instead of this browser page.
                    </p>
                    <input
                      id="sldt-proxy"
                      type="url"
                      inputMode="url"
                      autoComplete="off"
                      spellCheck={false}
                      value={sldtProxyUrl}
                      onChange={(event) => setSldtProxyUrl(event.target.value)}
                      placeholder="https://sldt-proxy.example.workers.dev"
                      className="h-11 w-full rounded border border-line bg-surface-2 px-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                    />
                  </>
                )}
              </div>
            )}
          </section>

          {/* -- connectors: Google + MCP ----------------------------------- */}
          <section hidden={!show("connectors")} className="pocket-setting-section"><ConnectorsSection /></section>

          {/* -- destructive, kept apart from everything else --------------- */}
          <section hidden={!show("device")} className="pocket-setting-section border-t border-line pt-5">
            {pocket && <div className="pocket-storage-warning"><h3>Reset this device</h3><p>Removes this device’s local copy. Changes that have not synced will be lost. Your remote data is not erased.</p></div>}
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
        </div>
        </div>

        {/* The sheet is `fixed`, so it sits outside the shell's safe-area
            padding and has to inset its own footer — otherwise Save sits under
            the gesture bar, which is where a thumb naturally lands. */}
        <footer
          hidden={pocket && !dirty}
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
            {pocket ? "Save & restart" : "Save & reload"}
          </button>
        </footer>
      </div>
    </div>
  );
}
