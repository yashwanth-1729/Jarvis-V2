"use client";

import * as React from "react";
import { toast } from "sonner";
import { Camera, ChatCircle, MusicNotes } from "@phosphor-icons/react";

import type { VoiceSessionState } from "@/types";
import { emitFx, setFxActivity, setFxScene, type FxScene } from "../fx/fxBus";
import { LiveBackdropPicker } from "../fx/LiveBackdropPicker";
import { APP_ICONS, canSwitchAppIcon, currentAppIcon, setAppIcon, type AppIconId } from "../lib/appIcon";
import { haptic } from "../lib/haptics";
import { useLook, useNavState } from "../PhoneContext";
import { Choices } from "../ui/Form";
import { Tap } from "../ui/Tap";
import { Icon3D } from "../ui/Icon3D";
import { HoloFace } from "../voice/HoloFace";
import { HoloMascot } from "../voice/HoloMascot";

/*
 * Design lab: try every open design decision on the phone itself.
 *
 * The launcher icon switches for real (Android launcher aliases, see
 * lib/appIcon.ts). The app name is previewed only; it changes everywhere once
 * it is chosen. Picks are remembered on this device so they survive leaving
 * the page, and "Copy my picks" hands them over as one line.
 */

const NAMES = ["JARVIS", "Holo", "Hollo", "Kairo", "Holobud", "Nudgy"];
const PICKS_KEY = "jarvis.phone.picks";

interface Picks {
  icon: AppIconId;
  name: string;
}

function readPicks(): Picks {
  try {
    const saved = JSON.parse(localStorage.getItem(PICKS_KEY) ?? "null") as Partial<Picks> | null;
    return {
      icon: APP_ICONS.some((icon) => icon.id === saved?.icon) ? (saved?.icon as AppIconId) : currentAppIcon() ?? "classic",
      name: typeof saved?.name === "string" && saved.name.trim() ? saved.name : "JARVIS",
    };
  } catch {
    return { icon: currentAppIcon() ?? "classic", name: "JARVIS" };
  }
}

function usePicks(): [Picks, (next: Partial<Picks>) => void] {
  const [picks, setPicks] = React.useState<Picks>({ icon: "classic", name: "JARVIS" });
  React.useEffect(() => setPicks(readPicks()), []);
  const update = React.useCallback((next: Partial<Picks>) => {
    setPicks((current) => {
      const merged = { ...current, ...next };
      try {
        localStorage.setItem(PICKS_KEY, JSON.stringify(merged));
      } catch {
        /* The pick still shows for this visit. */
      }
      return merged;
    });
  }, []);
  return [picks, update];
}

export function DesignLab() {
  const [picks, update] = usePicks();
  const { fx } = useLook();
  const { tab } = useNavState();
  const [peek, setPeek] = React.useState(false);
  const icon = APP_ICONS.find((item) => item.id === picks.icon) ?? APP_ICONS[0];

  // The palette buttons below repaint the background; put the current tab's
  // palette back when leaving.
  React.useEffect(() => () => setFxScene(tab), [tab]);

  return (
    <div className="ph-lab" data-peek={peek}>
      <p className="ph-lab-intro">
        Try everything on your phone before deciding. Picks are saved as you go; copy them at the bottom and send them to Claude.
      </p>
      <Preview icon={icon.src} name={picks.name} />
      <IconSection picked={picks.icon} onPick={(id) => update({ icon: id })} />
      <NameSection name={picks.name} onPick={(name) => update({ name })} />
      <BackgroundSection onPeek={setPeek} />
      <HoloSection />
      <Summary icon={icon.name} name={picks.name} background={fx} />
    </div>
  );
}

/** A home-screen row and a store card, showing the picked icon and name together. */
function Preview({ icon, name }: { icon: string; name: string }) {
  const others: Array<{ label: string; tone: string; Icon: React.ElementType }> = [
    { label: "Camera", tone: "sky", Icon: Camera },
    { label: "Music", tone: "orange", Icon: MusicNotes },
    { label: "Messages", tone: "mint", Icon: ChatCircle },
  ];
  return (
    <section className="ph-lab-preview" aria-label="Preview of your picks">
      <div className="ph-lab-home">
        <div className="ph-lab-apps">
          {others.slice(0, 2).map(({ label, tone, Icon }) => (
            <span key={label} className="ph-lab-app" data-tone={tone}>
              <i><Icon size={26} weight="fill" /></i>
              <small>{label}</small>
            </span>
          ))}
          <span className="ph-lab-app ph-lab-app-mine">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={icon} alt="" />
            <small>{name}</small>
          </span>
          {others.slice(2).map(({ label, tone, Icon }) => (
            <span key={label} className="ph-lab-app" data-tone={tone}>
              <i><Icon size={26} weight="fill" /></i>
              <small>{label}</small>
            </span>
          ))}
        </div>
      </div>
      <div className="ph-lab-store">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={icon} alt="" />
        <span className="ph-lab-store-copy">
          <strong>{name}</strong>
          <small>Personal AI · plans, tasks and voice</small>
        </span>
        <span className="ph-lab-install" aria-hidden="true">Install</span>
      </div>
    </section>
  );
}

function IconSection({ picked, onPick }: { picked: AppIconId; onPick: (id: AppIconId) => void }) {
  const [live, setLive] = React.useState<AppIconId | null>(null);
  const [native, setNative] = React.useState(false);
  React.useEffect(() => {
    setNative(canSwitchAppIcon());
    setLive(currentAppIcon());
  }, []);
  const chosen = APP_ICONS.find((item) => item.id === picked) ?? APP_ICONS[0];

  const apply = () => {
    if (setAppIcon(picked)) {
      setLive(picked);
      haptic("success");
      toast.success("Icon switched", { description: "Your launcher updates in a few seconds." });
    } else {
      haptic("warning");
      toast.error("Couldn't switch the icon", { description: "Try again, or reinstall the app if it keeps failing." });
    }
  };

  return (
    <section className="ph-section">
      <span className="ph-eyebrow">App icon</span>
      <div className="ph-lab-icons" role="radiogroup" aria-label="App icon">
        {APP_ICONS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={picked === item.id}
            className="ph-lab-icon ph-tap"
            data-on={picked === item.id}
            onClick={() => {
              if (picked === item.id) return;
              haptic("select");
              onPick(item.id);
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.src} alt="" />
            <strong>{item.name}</strong>
            <small>{live === item.id ? "On your phone now" : item.hint}</small>
          </button>
        ))}
      </div>
      {native ? (
        <Tap className="ph-btn ph-btn-primary ph-btn-wide" onClick={apply} disabled={live === picked} feel={false}>
          {live === picked ? "This one is on your home screen" : `Put "${chosen.name}" on my home screen`}
        </Tap>
      ) : (
        <p className="ph-field-hint">Switching the real launcher icon works in the Android app.</p>
      )}
      <p className="ph-field-hint">
        The launcher can take a few seconds to catch up. If the icon disappears from your home screen, add it again from the app drawer.
      </p>
    </section>
  );
}

function NameSection({ name, onPick }: { name: string; onPick: (name: string) => void }) {
  const [custom, setCustom] = React.useState("");
  const preset = NAMES.includes(name);
  return (
    <section className="ph-section">
      <span className="ph-eyebrow">App name</span>
      <Choices
        label="App name"
        value={preset ? name : ""}
        onChange={(value) => {
          setCustom("");
          onPick(value);
        }}
        options={NAMES.map((value) => ({ value, label: value === "JARVIS" ? "JARVIS (now)" : value, tone: "lilac" as const }))}
      />
      <input
        className="ph-input"
        aria-label="Your own name"
        placeholder="Or type your own"
        value={custom || (preset ? "" : name)}
        maxLength={30}
        onChange={(event) => {
          setCustom(event.target.value);
          if (event.target.value.trim()) onPick(event.target.value.trim());
        }}
      />
      <p className="ph-field-hint">
        Watch the preview at the top. The real name (home screen, store listing, inside the app) changes once you confirm it with Claude.
      </p>
    </section>
  );
}

const SCENES: Array<{ value: FxScene; label: string }> = [
  { value: "today", label: "Today" },
  { value: "tasks", label: "Tasks" },
  { value: "plan", label: "Plan" },
  { value: "memory", label: "Memory" },
];

function BackgroundSection({ onPeek }: { onPeek: (peek: boolean) => void }) {
  const [scene, setScene] = React.useState<FxScene>("today");
  const typing = React.useRef(0);
  React.useEffect(() => () => {
    window.clearTimeout(typing.current);
    setFxActivity("lab", 0);
  }, []);

  return (
    <section className="ph-section">
      <span className="ph-eyebrow">Live background</span>
      <LiveBackdropPicker />
      <span className="ph-field-label">Colours per tab</span>
      <div className="ph-choices" data-wrap="true" role="radiogroup" aria-label="Background colours">
        {SCENES.map(({ value, label }, index) => (
          <Tap
            key={value}
            role="radio"
            aria-checked={scene === value}
            className="ph-choice"
            data-tone="sky"
            data-on={scene === value}
            feel="select"
            squish={0.92}
            onClick={() => {
              const from = SCENES.findIndex((item) => item.value === scene);
              emitFx("tab", undefined, index > from ? 1 : -1);
              setFxScene(value);
              setScene(value);
            }}
          >
            {label}
          </Tap>
        ))}
      </div>
      <span className="ph-field-label">Try the reactions</span>
      <div className="ph-choices" data-wrap="true">
        <Tap className="ph-choice" data-tone="lime" feel="tap" squish={0.92}>Tap</Tap>
        <Tap className="ph-choice" data-tone="sky" feel="select" squish={0.92}>Select</Tap>
        <Tap className="ph-choice" data-tone="lime" feel="success" squish={0.92}>Task done</Tap>
        <Tap className="ph-choice" data-tone="red" feel="warning" squish={0.92}>Delete</Tap>
        <Tap className="ph-choice" data-tone="lilac" feel="heavy" squish={0.92}>Big press</Tap>
        <Tap className="ph-choice" data-tone="mint" feel="toggle-on" squish={0.92}>Toggle</Tap>
        <Tap
          className="ph-choice"
          data-tone="pink"
          feel="select"
          squish={0.92}
          onClick={() => {
            window.clearTimeout(typing.current);
            setFxActivity("lab", 0.75);
            typing.current = window.setTimeout(() => {
              setFxActivity("lab", 0);
              emitFx("select", { x: 0.5, y: 0.82 });
            }, 4000);
          }}
        >
          JARVIS typing (4 s)
        </Tap>
      </div>
      <button
        type="button"
        className="ph-btn ph-btn-wide ph-lab-peek"
        onPointerDown={() => onPeek(true)}
        onPointerUp={() => onPeek(false)}
        onPointerCancel={() => onPeek(false)}
        onPointerLeave={() => onPeek(false)}
        onContextMenu={(event) => event.preventDefault()}
      >
        <Icon3D name="eye" size={22} /> Hold to see the background alone
      </button>
    </section>
  );
}

const STATES: Array<{ value: string; label: string; session: VoiceSessionState; muted?: boolean }> = [
  { value: "connecting", label: "Waking up", session: "connecting" },
  { value: "listening", label: "Listening", session: "listening" },
  { value: "hearing", label: "Hearing you", session: "hearing" },
  { value: "thinking", label: "Thinking", session: "thinking" },
  { value: "speaking", label: "Speaking", session: "speaking" },
  { value: "muted", label: "Muted", session: "listening", muted: true },
  { value: "idle", label: "Offline", session: "idle" },
];

/** Speech-like levels (syllables in phrases, with pauses) for the preview. */
function useSimulatedLevels(state: string) {
  const levelRef = React.useRef(0);
  const output = React.useRef(0);
  React.useEffect(() => {
    let frame = 0;
    const tick = (time: number) => {
      const syllables = Math.abs(Math.sin(time / 115)) * (0.55 + 0.45 * Math.sin(time / 690));
      const phrase = Math.sin(time / 1700) > -0.55 ? 1 : 0.08;
      const level = Math.min(1, 0.12 + 0.75 * syllables * phrase);
      levelRef.current = state === "hearing" ? level : 0;
      output.current = state === "speaking" ? level : 0;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state]);
  const outputLevel = React.useCallback(() => output.current, []);
  return { levelRef, outputLevel };
}

function HoloSection() {
  const [value, setValue] = React.useState("listening");
  const [boop, setBoop] = React.useState(0);
  const [failed, setFailed] = React.useState(false);
  const [visible, setVisible] = React.useState(false);
  const stage = React.useRef<HTMLDivElement>(null);
  const current = STATES.find((item) => item.value === value) ?? STATES[1];
  const { levelRef, outputLevel } = useSimulatedLevels(value);

  // Only draw HOLO while its stage is on screen.
  React.useEffect(() => {
    const node = stage.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "120px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="ph-section">
      <span className="ph-eyebrow">HOLO, the voice mascot</span>
      <div ref={stage} className="ph-lab-holo">
        <button type="button" className="ph-lab-holo-stage" aria-label="Boop HOLO" onClick={() => {
          haptic("tap", false);
          setBoop((count) => count + 1);
        }}>
          {visible && !failed && (
            <HoloMascot
              size={300}
              state={current.session}
              muted={current.muted === true}
              boop={boop}
              levelRef={levelRef}
              outputLevel={outputLevel}
              onReady={(ready) => setFailed(!ready)}
            />
          )}
          {failed && <HoloFace size={140} state={current.muted ? "muted" : current.session} />}
        </button>
      </div>
      <Choices
        label="HOLO state"
        value={value}
        onChange={setValue}
        options={STATES.map(({ value: state, label }) => ({ value: state, label, tone: "sky" as const }))}
      />
      <p className="ph-field-hint">Tap HOLO to boop it. Hearing you and Speaking use a simulated voice.</p>
    </section>
  );
}

function Summary({ icon, name, background }: { icon: string; name: string; background: string }) {
  const text = `My picks: icon ${icon}, name ${name}, live background ${background}.`;
  return (
    <section className="ph-lab-summary">
      <span className="ph-eyebrow">Your picks</span>
      <ul>
        <li><span>Icon</span><strong>{icon}</strong></li>
        <li><span>Name</span><strong>{name}</strong></li>
        <li><span>Live background</span><strong>{background}</strong></li>
      </ul>
      <Tap
        className="ph-btn ph-btn-primary ph-btn-wide"
        feel="success"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(
            () => toast.success("Copied", { description: "Paste it to Claude to lock these in." }),
            () => toast.error("Copy is not allowed here", { description: text }),
          );
        }}
      >
        <Icon3D name="copy" size={22} /> Copy my picks
      </Tap>
    </section>
  );
}
