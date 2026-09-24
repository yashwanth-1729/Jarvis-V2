"use client";

import * as React from "react";

import {
  GEMINI_KEY_STORAGE,
  OPENROUTER_KEY_STORAGE,
  PROVIDER_KEY_STORAGE,
  getGeminiKey,
  getOpenRouterKey,
  getProviderKey,
} from "@/lib/agentBridge";
import { API_BASE, API_BASE_STORAGE_KEY } from "@/lib/api";
import { clearAll } from "@/lib/localdb";
import { readLocation, reportLocation, setLocationByName, type RememberedLocation } from "@/lib/geo";
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

export type ProbeState = "idle" | "checking" | "ok" | "fail";

/** Read one stored setting, independent of whether the others are set.
 *  `getSupabaseConfig()` deliberately returns null unless the pair is
 *  complete — correct for deciding whether sync can run, wrong for
 *  repopulating a form, where it silently discards a half-finished entry. */
function stored(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/**
 * Everything the settings screens edit, independent of how they look.
 *
 * Both the desktop dialog and the phone's settings pages render from this, so
 * the two cannot disagree about what "Save & restart" writes, when a draft is
 * dirty, or how an SLDT dataset is created and paired.
 *
 * The addresses and keys are runtime settings rather than build-time
 * constants, for reasons that only bite once the app is packaged: a phone has
 * no devtools console to poke localStorage from, a laptop's DHCP address
 * changes, and baking a Supabase key into an APK puts it in every copy of the
 * file. Entering them here means one build works against a home laptop today
 * and a VPS later.
 */
export function useSettingsModel() {
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
  const locate = React.useCallback(async () => {
    setLocating(true);
    const found = await reportLocation(true);
    if (found) setPlace(found);
    setLocating(false);
  }, []);

  const nameIt = React.useCallback(async () => {
    const cleaned = placeName.trim();
    if (!cleaned) return;
    setLocating(true);
    const found = await setLocationByName(cleaned);
    if (found) {
      setPlace(found);
      setPlaceName("");
    }
    setLocating(false);
  }, [placeName]);

  const [backend, setBackendValue] = React.useState(() => stored(API_BASE_STORAGE_KEY));
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
  const [backendProbe, setBackendProbe] = React.useState<ProbeState>("idle");
  /** Whether the runtime currently holds a provider key, per its health. */
  const [runtimeHasKey, setRuntimeHasKey] = React.useState<boolean | null>(null);
  const [runtimeHasGeminiKey, setRuntimeHasGeminiKey] = React.useState<boolean | null>(null);
  const [runtimeHasOpenRouterKey, setRuntimeHasOpenRouterKey] = React.useState<boolean | null>(null);

  const draft = JSON.stringify([backend, supabaseUrl, supabaseKey, providerKey, geminiKey, openrouterKey, syncBackend, sldtDatasetId, sldtRepo, sldtBranch, sldtPathPrefix, sldtWriteMode, sldtProxyUrl, sldtDirectToken]);
  const originalDraft = React.useRef(draft);
  const dirty = draft !== originalDraft.current;

  /** Editing the address invalidates the last connection test. */
  const setBackend = React.useCallback((value: string) => {
    setBackendValue(value);
    setBackendProbe("idle");
  }, []);

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

  /** Persist every draft and restart. */
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

  /** Erase this device's local copy. Callers must confirm first. */
  const eraseLocalData = React.useCallback(async () => {
    await clearAll();
    window.location.reload();
  }, []);

  return {
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
    dirty,
    save,
    eraseLocalData,
  };
}

export type SettingsModel = ReturnType<typeof useSettingsModel>;
