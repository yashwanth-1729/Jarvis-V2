"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowsClockwise,
  CaretLeft,
  CaretRight,
  CheckCircle,
  CircleNotch,
  Crosshair,
  DeviceMobile,
  Eye,
  EyeSlash,
  Moon,
  Sun,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";

import { ConnectorsSection } from "@/components/ConnectorsSection";
import { API_BASE, isNativeShell } from "@/lib/api";
import { useSettingsModel, type SettingsModel } from "@/lib/useSettingsModel";
import { useBackLayer } from "../lib/backStack";
import type { Tone } from "../lib/derive";
import { LiveBackdropPicker } from "../fx/LiveBackdropPicker";
import type { ThemeChoice } from "../lib/theme";
import { useAppData, useLook, useNav, useSyncState } from "../PhoneContext";
import { Choices, Field, TextInput } from "../ui/Form";
import { Screen } from "../ui/Screen";
import { Tap } from "../ui/Tap";
import { Icon3D, type Icon3DName } from "../ui/Icon3D";
import { DesignLab } from "./DesignLab";

type Page = "lab" | "keys" | "apps" | "sync" | "location" | "runtime" | "storage";

const PAGES: Array<{ id: Page; title: string; hint: string; tone: Tone; icon: Icon3DName; group: string }> = [
  { id: "lab", title: "Design lab", hint: "Try the icons, names, backgrounds and HOLO", tone: "lime", icon: "flask", group: "Make it yours" },
  { id: "keys", title: "AI & voice keys", hint: "Sarvam, Gemini and OpenRouter", tone: "amber", icon: "key", group: "Connections" },
  { id: "apps", title: "Connected apps", hint: "Google services and MCP tools", tone: "sky", icon: "plug", group: "Connections" },
  { id: "sync", title: "Sync & backup", hint: "How your devices share data", tone: "lilac", icon: "sync", group: "Connections" },
  { id: "location", title: "Location", hint: "For weather and local results", tone: "orange", icon: "compass", group: "This device" },
  { id: "runtime", title: "Assistant connection", hint: "Runtime address and a quick test", tone: "mint", icon: "server", group: "This device" },
  { id: "storage", title: "Local storage", hint: "Reset this device's copy", tone: "pink", icon: "broom", group: "This device" },
];

export function SettingsScreen() {
  const { pop } = useNav();
  const model = useSettingsModel();
  const [page, setPage] = React.useState<Page | null>(null);
  const [direction, setDirection] = React.useState(1);
  const closePage = React.useCallback(() => {
    setDirection(-1);
    setPage(null);
  }, []);
  useBackLayer(page !== null, closePage);
  const current = PAGES.find((item) => item.id === page);

  return (
    <div className="ph-settings">
      <AnimatePresence initial={false} custom={direction} mode="popLayout">
        {current ? (
          <motion.div
            key={current.id}
            className="ph-settings-page"
            custom={direction}
            initial={{ opacity: 0, transform: "translateX(36%)" }}
            animate={{ opacity: 1, transform: "translateX(0%)" }}
            exit={{ opacity: 0, transform: "translateX(36%)", transition: { duration: 0.18, ease: [0.4, 0, 1, 1] } }}
            transition={{ type: "spring", stiffness: 380, damping: 40 }}
          >
            <Screen
              title={current.title}
              tone={current.tone}
              bottomPad={false}
              leading={
                <Tap className="ph-icon-btn" aria-label="Back to settings" onClick={closePage} feel="select">
                  <CaretLeft size={22} weight="bold" />
                </Tap>
              }
              eyebrow={current.hint}
            >
              <div className="ph-stack ph-settings-body">
                {current.id === "lab" && <DesignLab />}
                {current.id === "keys" && <KeysPage model={model} />}
                {current.id === "apps" && <div className="ph-legacy"><ConnectorsSection /></div>}
                {current.id === "sync" && <SyncPage model={model} />}
                {current.id === "location" && <LocationPage model={model} />}
                {current.id === "runtime" && <RuntimePage model={model} />}
                {current.id === "storage" && <StoragePage model={model} />}
              </div>
            </Screen>
          </motion.div>
        ) : (
          <motion.div
            key="home"
            className="ph-settings-page"
            initial={{ opacity: 0, transform: "translateX(-18%)" }}
            animate={{ opacity: 1, transform: "translateX(0%)" }}
            exit={{ opacity: 0, transform: "translateX(-18%)", transition: { duration: 0.16, ease: [0.4, 0, 1, 1] } }}
            transition={{ type: "spring", stiffness: 380, damping: 40 }}
          >
            <Screen
              title="Settings"
              tone="lime"
              bottomPad={false}
              eyebrow="Make JARVIS yours"
              leading={
                <Tap className="ph-icon-btn" aria-label="Close settings" onClick={pop} feel="select">
                  <CaretLeft size={22} weight="bold" />
                </Tap>
              }
            >
              <div className="ph-stack ph-settings-body">
                <StatusStrip />
                <Appearance />
                <LiveBackdrop />
                {["Make it yours", "Connections", "This device"].map((group) => (
                  <section key={group} className="ph-section">
                    <span className="ph-eyebrow">{group}</span>
                    <div className="ph-rows">
                      {PAGES.filter((item) => item.group === group).map(({ id, title, hint, tone, icon }) => (
                        <Tap
                          key={id}
                          className="ph-row"
                          onClick={() => {
                            setDirection(1);
                            setPage(id);
                          }}
                          squish={0.98}
                        >
                          <span className="ph-row-icon" data-tone={tone}><Icon3D name={icon} size={30} /></span>
                          <span className="ph-row-copy">
                            <strong>{title}</strong>
                            <small>{hint}</small>
                          </span>
                          <CaretRight size={18} weight="bold" className="ph-row-caret" />
                        </Tap>
                      ))}
                    </div>
                  </section>
                ))}
                <p className="ph-settings-foot">JARVIS 3 · built for you, by you</p>
              </div>
            </Screen>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {model.dirty && (
          <motion.div
            className="ph-savebar"
            initial={{ transform: "translateY(120px)" }}
            animate={{ transform: "translateY(0px)" }}
            exit={{ transform: "translateY(120px)" }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
          >
            <span>Unsaved connection changes</span>
            <Tap className="ph-btn ph-btn-primary" onClick={() => model.save()} feel="success">
              Save & restart
            </Tap>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function StatusStrip() {
  const { app } = useAppData();
  const sync = useSyncState();
  const online = !app.error && !app.localOnly && app.status !== "offline";
  const items = [
    { label: "Assistant", value: online ? "Online" : "Offline", ok: online },
    { label: "Voice", value: app.voiceAvailable ? "Ready" : "Not ready", ok: app.voiceAvailable },
    {
      label: "Sync",
      value: !app.recordsLocal ? "Desktop" : !sync.configured ? "Off" : sync.phase === "error" ? "Retrying" : sync.phase === "syncing" ? "Syncing" : sync.age || "On",
      ok: app.recordsLocal ? sync.configured && sync.phase !== "error" : true,
    },
  ];
  return (
    <div className="ph-status-strip">
      {items.map((item, index) => (
        <div key={item.label} className="ph-status ph-rise" data-ok={item.ok} style={{ "--i": index } as React.CSSProperties}>
          <span className="ph-status-dot" />
          <small>{item.label}</small>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

function Appearance() {
  const theme = useLook();
  const options: Array<{ value: ThemeChoice; label: string; icon: React.ElementType }> = [
    { value: "system", label: "System", icon: DeviceMobile },
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
  ];
  return (
    <section className="ph-section">
      <span className="ph-eyebrow">Look</span>
      <div className="ph-themes" role="radiogroup" aria-label="Appearance">
        {options.map(({ value, label, icon: Icon }) => (
          <Tap key={value} role="radio" aria-checked={theme.choice === value} className="ph-theme" data-choice={value} data-on={theme.choice === value} feel="select" onClick={() => theme.choose(value)}>
            <span className="ph-theme-preview" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="ph-theme-label"><Icon size={15} weight="fill" /> {label}</span>
          </Tap>
        ))}
      </div>
      <p className="ph-field-hint">System follows your phone. Applies instantly.</p>
    </section>
  );
}

/** The live background: how loud it is, or off. */
function LiveBackdrop() {
  return (
    <section className="ph-section">
      <span className="ph-eyebrow">Live background</span>
      <LiveBackdropPicker />
    </section>
  );
}

function Secret({ label, value, onChange, placeholder, status }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; status: boolean | null }) {
  const [visible, setVisible] = React.useState(false);
  return (
    <div className="ph-secret">
      <div className="ph-secret-box">
        <input
          className="ph-input"
          data-mono="true"
          aria-label={label}
          type={visible ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
        <button type="button" className="ph-secret-eye" aria-label={visible ? `Hide ${label}` : `Show ${label}`} onClick={() => setVisible((current) => !current)}>
          {visible ? <EyeSlash size={18} weight="bold" /> : <Eye size={18} weight="bold" />}
        </button>
      </div>
      {status !== null && (
        <span className="ph-secret-status" data-ok={status}>
          {status ? <CheckCircle size={14} weight="fill" /> : <WarningCircle size={14} weight="fill" />}
          {status ? "The runtime has this key." : "Not on the runtime yet — save to send it."}
        </span>
      )}
    </div>
  );
}

function KeysPage({ model }: { model: SettingsModel }) {
  return (
    <>
      <Field label="OpenRouter key" hint="Powers the cloud voice stack: chat, speech recognition and English/Hindi/Telugu speech. Required for voice on this device.">
        <Secret label="OpenRouter key" placeholder="sk-or-v1-…" value={model.openrouterKey} onChange={model.setOpenrouterKey} status={model.runtimeHasOpenRouterKey} />
      </Field>
      <Field label="Sarvam key" hint="Needed for the assistant and voice; the board works without it. Held on this device and handed to the runtime when it starts.">
        <Secret label="Sarvam key" placeholder="sk_…" value={model.providerKey} onChange={model.setProviderKey} status={model.runtimeHasKey} />
      </Field>
      <Field label="Gemini key · optional" hint="Your own Google Gemini key for English chat, with Sarvam as the automatic fallback. Leave blank to stay on Sarvam.">
        <Secret label="Gemini key" placeholder="AIza…" value={model.geminiKey} onChange={model.setGeminiKey} status={model.runtimeHasGeminiKey} />
      </Field>
    </>
  );
}

function SyncPage({ model }: { model: SettingsModel }) {
  return (
    <>
      <Field label="Sync backend" hint="Carries your board between devices.">
        <Choices
          label="Sync backend"
          value={model.syncBackend}
          onChange={model.setSyncBackendChoice}
          options={[
            { value: "supabase", label: "Supabase", tone: "lilac" },
            { value: "sldt", label: "SLDT · GitHub", tone: "sky" },
          ]}
        />
      </Field>
      {model.syncBackend === "supabase" ? (
        <>
          <Field label="Sync project URL">
            <TextInput label="Sync project URL" type="url" placeholder="https://your-project.supabase.co" value={model.supabaseUrl} onChange={model.setSupabaseUrl} />
          </Field>
          <Field label="Sync key" hint="Stored on this device only, never in the app bundle.">
            <Secret label="Sync key" placeholder="eyJ…" value={model.supabaseKey} onChange={model.setSupabaseKey} status={null} />
          </Field>
        </>
      ) : (
        <>
          <p className="ph-field-hint">Your board syncs as encrypted objects in a GitHub repo you own. See jarvis-oss/sldt/README.md for how it works.</p>
          {model.sldtNewRecoveryCode ? (
            <div className="ph-callout" data-tone="lime">
              <strong>Save this recovery code now.</strong>
              <p>It is the only way back into this dataset and cannot be shown again.</p>
              <code>{model.sldtNewRecoveryCode}</code>
              <Tap className="ph-btn ph-btn-small" onClick={() => model.setSldtNewRecoveryCode(null)}>I’ve saved it</Tap>
            </div>
          ) : model.sldtUnlocked ? (
            <p className="ph-secret-status" data-ok="true"><CheckCircle size={14} weight="fill" /> Unlocked for this session (dataset {model.sldtDatasetId.slice(0, 8)}…)</p>
          ) : model.sldtDatasetId ? (
            <Field label="Recovery code" hint="This device knows the dataset but needs its recovery code again. It is never stored, by design.">
              <div className="ph-inline">
                <TextInput label="Recovery code" type="password" mono placeholder="SLDT:…" value={model.sldtRecoveryInput} onChange={model.setSldtRecoveryInput} />
                <Tap className="ph-btn" onClick={model.pairSldtRecoveryCode}>Unlock</Tap>
              </div>
            </Field>
          ) : (
            <>
              <Tap className="ph-btn ph-btn-wide" onClick={model.generateSldtIdentity}>Create a new dataset</Tap>
              <Field label="Or pair with another device">
                <div className="ph-inline">
                  <TextInput label="Recovery code" type="password" mono placeholder="SLDT:…" value={model.sldtRecoveryInput} onChange={model.setSldtRecoveryInput} />
                  <Tap className="ph-btn" onClick={model.pairSldtRecoveryCode}>Pair</Tap>
                </div>
              </Field>
            </>
          )}
          {model.sldtError && <p className="ph-form-error"><WarningCircle size={16} weight="fill" /> {model.sldtError}</p>}
          <Field label="GitHub repo">
            <TextInput label="GitHub repo" mono placeholder="yourname/sldt-storage" value={model.sldtRepo} onChange={model.setSldtRepo} />
          </Field>
          <div className="ph-field-row">
            <Field label="Branch">
              <TextInput label="Branch" mono value={model.sldtBranch} onChange={model.setSldtBranch} />
            </Field>
            <Field label="Path prefix">
              <TextInput label="Path prefix" mono value={model.sldtPathPrefix} onChange={model.setSldtPathPrefix} />
            </Field>
          </div>
          <Field label="How this device writes">
            <Choices
              label="Write mode"
              value={model.sldtWriteMode}
              onChange={model.setSldtWriteMode}
              options={[
                { value: "direct", label: "Direct", tone: "sky" },
                { value: "proxy", label: "Through a proxy", tone: "lilac" },
              ]}
            />
          </Field>
          {model.sldtWriteMode === "direct" ? (
            <Field label="GitHub token" hint="A fine-grained token scoped to this repo, Contents: read and write. Stored on this device only.">
              <Secret label="GitHub token" placeholder="github_pat_…" value={model.sldtDirectToken} onChange={model.setSldtDirectToken} status={null} />
            </Field>
          ) : (
            <Field label="Proxy URL" hint="Where jarvis-oss/proxy is deployed; it holds the GitHub token instead of this device.">
              <TextInput label="Proxy URL" type="url" placeholder="https://sldt-proxy.example.workers.dev" value={model.sldtProxyUrl} onChange={model.setSldtProxyUrl} />
            </Field>
          )}
        </>
      )}
    </>
  );
}

function LocationPage({ model }: { model: SettingsModel }) {
  const place = model.place;
  return (
    <>
      <div className="ph-callout" data-tone="orange">
        <span className="ph-eyebrow">Right now</span>
        <strong className="ph-callout-big">{place ? place.label : "Not known yet"}</strong>
        {place && (
          <p>{place.source === "gps" ? "From GPS" : place.source === "manual" ? "Set by you" : "From your network, so it may name a nearby city"}</p>
        )}
      </div>
      <Field label="Change it" hint="Set your city, or use GPS for accurate local weather and nearby results.">
        <div className="ph-inline">
          <input
            className="ph-input"
            aria-label="Set location by name"
            placeholder="Type a city…"
            value={model.placeName}
            onChange={(event) => model.setPlaceName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void model.nameIt();
            }}
          />
          <Tap className="ph-btn" disabled={model.locating} onClick={() => void (model.placeName.trim() ? model.nameIt() : model.locate())}>
            {model.locating ? <CircleNotch size={18} className="ph-spin" /> : model.placeName.trim() ? "Set" : <><Crosshair size={18} weight="bold" /> GPS</>}
          </Tap>
        </div>
      </Field>
    </>
  );
}

function RuntimePage({ model }: { model: SettingsModel }) {
  return (
    <>
      <Field label="JARVIS runtime" hint={`Handles the assistant and voice. Not needed to read or edit your board.${isNativeShell() ? " On this device it is normally http://127.0.0.1:8000." : " Leave blank to use this page's host."}`}>
        <div className="ph-inline">
          <TextInput label="Runtime address" type="url" mono placeholder={API_BASE} value={model.backend} onChange={model.setBackend} />
          <Tap className="ph-btn" onClick={() => void model.probeBackend()}>
            {model.backendProbe === "checking" ? <CircleNotch size={18} className="ph-spin" /> : <><ArrowsClockwise size={16} weight="bold" /> Test</>}
          </Tap>
        </div>
      </Field>
      <AnimatePresence>
        {(model.backendProbe === "ok" || model.backendProbe === "fail") && (
          <motion.p
            className="ph-secret-status"
            data-ok={model.backendProbe === "ok"}
            aria-live="polite"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            {model.backendProbe === "ok" ? <CheckCircle size={14} weight="fill" /> : <XCircle size={14} weight="fill" />}
            {model.backendProbe === "ok" ? "Runtime reachable." : "No runtime at that address. The board still works without it."}
          </motion.p>
        )}
      </AnimatePresence>
    </>
  );
}

function StoragePage({ model }: { model: SettingsModel }) {
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  return (
    <div className="ph-callout" data-tone="red">
      <strong className="ph-callout-big">Reset this device</strong>
      <p>Removes this device’s local copy. Changes that have not synced yet will be lost. Your synced data elsewhere is not erased.</p>
      <AnimatePresence mode="wait" initial={false}>
        {confirming ? (
          <motion.div key="confirm" className="ph-inline" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <Tap className="ph-btn" onClick={() => setConfirming(false)} disabled={busy}>Cancel</Tap>
            <Tap
              className="ph-btn ph-btn-danger"
              feel="warning"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void model.eraseLocalData();
              }}
            >
              {busy ? <CircleNotch size={18} className="ph-spin" /> : "Erase everything here"}
            </Tap>
          </motion.div>
        ) : (
          <motion.div key="ask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Tap className="ph-btn ph-btn-danger-ghost" onClick={() => setConfirming(true)}>Erase local data</Tap>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
