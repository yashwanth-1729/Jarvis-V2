"use client";

import { ConnectorsSection } from "@/components/ConnectorsSection";
import { Check, Eye, EyeOff, Loader2, X } from "lucide-react";
import * as React from "react";

import { API_BASE, isNativeShell } from "@/lib/api";
import { useSettingsModel } from "@/lib/useSettingsModel";
import { cn } from "@/lib/utils";

/**
 * Where the two addresses JARVIS needs are entered.
 *
 * The draft, save and erase logic lives in `useSettingsModel`, shared with the
 * phone's settings pages; this is the desktop dialog presentation of it.
 */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const {
    place,
    placeName,
    setPlaceName,
    locating,
    locate,
    nameIt,
    backend,
    setBackend,
    backendProbe,
    probeBackend,
    supabaseUrl,
    setSupabaseUrl,
    supabaseKey,
    setSupabaseKey,
    syncBackend,
    setSyncBackendChoice,
    sldtDatasetId,
    sldtRepo,
    setSldtRepo,
    sldtBranch,
    setSldtBranch,
    sldtPathPrefix,
    setSldtPathPrefix,
    sldtWriteMode,
    setSldtWriteMode,
    sldtProxyUrl,
    setSldtProxyUrl,
    sldtDirectToken,
    setSldtDirectToken,
    sldtUnlocked,
    sldtRecoveryInput,
    setSldtRecoveryInput,
    sldtNewRecoveryCode,
    setSldtNewRecoveryCode,
    sldtError,
    generateSldtIdentity,
    pairSldtRecoveryCode,
    providerKey,
    setProviderKey,
    geminiKey,
    setGeminiKey,
    openrouterKey,
    setOpenrouterKey,
    runtimeHasKey,
    runtimeHasGeminiKey,
    runtimeHasOpenRouterKey,
    save,
    eraseLocalData,
  } = useSettingsModel();
  const [showKey, setShowKey] = React.useState(false);
  const [showProviderKey, setShowProviderKey] = React.useState(false);
  const [showGeminiKey, setShowGeminiKey] = React.useState(false);
  const [showOpenRouterKey, setShowOpenRouterKey] = React.useState(false);
  const [showSldtToken, setShowSldtToken] = React.useState(false);
  const [confirmReset, setConfirmReset] = React.useState(false);

  const dialogRef = React.useRef<HTMLDivElement>(null);

  // Escape closes, and focus moves in on open so a keyboard or screen-reader
  // user is not left behind on the page underneath.
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
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
  }, [onClose]);

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
                onChange={(event) => setBackend(event.target.value)}
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
          <section className="space-y-2">
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
          <section className="space-y-2">
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
          <section className="space-y-2 border-t border-line pt-5">
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
          <section><ConnectorsSection /></section>

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
                    onClick={() => void eraseLocalData()}
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
            onClick={() => save()}
            className="inline-flex h-11 items-center rounded bg-accent px-5 text-sm font-semibold text-accent-ink hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            Save & reload
          </button>
        </footer>
      </div>
    </div>
  );
}
