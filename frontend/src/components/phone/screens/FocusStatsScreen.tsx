"use client";

import * as React from "react";
import { CaretLeft, CheckCircle, Fire, Lightning, Target, Timer, Trophy, XCircle } from "@phosphor-icons/react";

import { fetchFocusStats, type FocusItemStats, type FocusStats } from "@/lib/focus";
import { emitFx } from "../fx/fxBus";
import { haptic } from "../lib/haptics";
import { duration } from "../lib/time";
import { useNav } from "../PhoneContext";
import { Skeleton, Sticker } from "../ui/Bits";
import { Num } from "../ui/Num";
import { Screen } from "../ui/Screen";
import { Segmented } from "../ui/Segmented";
import { Tap } from "../ui/Tap";

type Range = "7" | "30" | "90";

function headline(stats: FocusStats): string {
  if (stats.rate == null) return "Day one energy.";
  if (stats.rate >= 0.9) return "Unstoppable.";
  if (stats.rate >= 0.7) return "Locked in.";
  if (stats.rate >= 0.4) return "Building it.";
  return "Comeback arc.";
}

const DAY = ["S", "M", "T", "W", "T", "F", "S"];

/**
 * How serious mode is going: loud on purpose, the payoff for the sober
 * Lock-in screen (the user asked for "crazy energetic" charts, 2026-10-02).
 */
export function FocusStatsScreen() {
  const { pop } = useNav();
  const [range, setRange] = React.useState<Range>("30");
  const [stats, setStats] = React.useState<FocusStats | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [shown, setShown] = React.useState(false);
  const celebrated = React.useRef(false);

  React.useEffect(() => {
    let alive = true;
    setShown(false);
    fetchFocusStats(Number(range))
      .then((next) => {
        if (!alive) return;
        setStats(next);
        setFailed(false);
        // Let the first frame paint at zero so everything visibly fills up.
        requestAnimationFrame(() => requestAnimationFrame(() => alive && setShown(true)));
        if (!celebrated.current && next.streak >= 2) {
          celebrated.current = true;
          window.setTimeout(() => {
            haptic("success");
            emitFx("success", { x: 0.5, y: 0.3 });
          }, 450);
        }
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [range]);

  const bars = stats ? stats.series.slice(-Math.min(stats.series.length, 21)) : [];
  const peak = Math.max(1, ...bars.map((day) => day.done + day.skipped));
  const rate = stats?.rate ?? 0;
  const ring = 2 * Math.PI * 54;

  return (
    <Screen
      title="Stats"
      tone="lime"
      bottomPad={false}
      className="ph-stats"
      leading={
        <Tap className="ph-icon-btn" aria-label="Back" onClick={pop} feel="select">
          <CaretLeft size={22} weight="bold" />
        </Tap>
      }
      eyebrow="Lock-in scoreboard"
      hero={
        <Segmented<Range>
          label="Range"
          size="sm"
          value={range}
          onChange={setRange}
          options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }]}
        />
      }
    >
      <div className="ph-stack">
        {!stats ? (
          failed ? <p className="ph-focus-quiet">{"Couldn't load your stats. Check the connection and come back."}</p> : <Skeleton rows={4} />
        ) : (
          <>
            <section className="ph-stats-hero" data-shown={shown}>
              <span className="ph-stats-glow" aria-hidden="true" />
              <div className="ph-stats-ring">
                <svg viewBox="0 0 128 128" aria-hidden="true">
                  <defs>
                    <linearGradient id="ph-ring-grad" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="#D4FF3A" />
                      <stop offset="55%" stopColor="#7CC7FF" />
                      <stop offset="100%" stopColor="#FF7AC6" />
                    </linearGradient>
                  </defs>
                  <circle className="ph-stats-ring-track" cx="64" cy="64" r="54" />
                  <circle
                    className="ph-stats-ring-fill"
                    cx="64"
                    cy="64"
                    r="54"
                    strokeDasharray={ring}
                    strokeDashoffset={shown ? ring * (1 - rate) : ring}
                  />
                </svg>
                <span className="ph-stats-ring-label">
                  <b><Num value={shown ? Math.round(rate * 100) : 0} />%</b>
                  <small>no-skip rate</small>
                </span>
              </div>
              <div className="ph-stats-head">
                <h2 className="ph-stats-title">{headline(stats)}</h2>
                {stats.streak >= 2 && <Sticker tone="orange" tilt={-4} pulse>{stats.streak}-DAY STREAK</Sticker>}
                <p className="ph-stats-sub">
                  {stats.done} done · {stats.skipped} skipped in {stats.days} days
                </p>
              </div>
            </section>

            <div className="ph-stats-tiles">
              <Tile icon={<Fire size={22} weight="fill" />} tone="orange" label="Streak" value={stats.streak} unit={stats.streak === 1 ? "day" : "days"} hot={stats.streak >= 3} />
              <Tile icon={<Trophy size={22} weight="fill" />} tone="amber" label="Best" value={stats.best_streak} unit={stats.best_streak === 1 ? "day" : "days"} />
              <Tile icon={<Timer size={22} weight="fill" />} tone="sky" label="Focused" text={duration(stats.minutes)} />
              <Tile icon={<Target size={22} weight="fill" />} tone="lilac" label="Perfect days" value={stats.perfect_days} />
            </div>

            <section className="ph-stats-card">
              <header>
                <strong><Lightning size={16} weight="fill" /> Every day</strong>
                <span className="ph-stats-legend"><i data-k="done" /> done <i data-k="skip" /> skipped</span>
              </header>
              <div className="ph-stats-bars" data-shown={shown}>
                {bars.map((day, index) => {
                  const date = new Date(`${day.date}T00:00:00`);
                  const isToday = index === bars.length - 1;
                  return (
                    <div key={day.date} className="ph-stats-bar" data-today={isToday} style={{ "--i": index } as React.CSSProperties} title={`${day.date}: ${day.done} done, ${day.skipped} skipped`}>
                      <span className="ph-stats-bar-stack">
                        <span className="ph-stats-bar-skip" style={{ height: `${(day.skipped / peak) * 100}%` }} />
                        <span className="ph-stats-bar-done" style={{ height: `${(day.done / peak) * 100}%` }} />
                      </span>
                      <small>{DAY[date.getDay()]}</small>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="ph-stats-card">
              <header><strong><CheckCircle size={16} weight="fill" /> The grid</strong><span className="ph-stats-legend">{stats.days} days</span></header>
              <div className="ph-stats-heat" data-shown={shown}>
                {stats.series.map((day, index) => {
                  const total = day.done + day.skipped;
                  const level = total === 0 ? 0 : day.skipped === 0 ? Math.min(4, 1 + day.done) : day.done === 0 ? -1 : -0.5;
                  return <span key={day.date} data-level={level} style={{ "--i": index } as React.CSSProperties} title={`${day.date}: ${day.done} done, ${day.skipped} skipped`} />;
                })}
              </div>
            </section>

            <HowFully stats={stats} shown={shown} />

            {stats.items.length > 0 && (
              <section className="ph-stats-card">
                <header><strong><Trophy size={16} weight="fill" /> Scoreboard</strong></header>
                <ul className="ph-stats-items">
                  {stats.items.map((item, index) => {
                    const total = Math.max(1, item.done + item.skipped);
                    return (
                      <li key={item.uid} style={{ "--i": index } as React.CSSProperties}>
                        <span className="ph-stats-item-name">{item.title}</span>
                        <span className="ph-stats-item-bar" data-shown={shown}>
                          <span data-k="done" style={{ width: `${(item.done / total) * 100}%` }} />
                          <span data-k="skip" style={{ width: `${(item.skipped / total) * 100}%` }} />
                        </span>
                        <span className="ph-stats-item-nums">
                          <CheckCircle size={14} weight="fill" /> {item.done}
                          <XCircle size={14} weight="fill" /> {item.skipped}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </Screen>
  );
}

/**
 * How fully things get done (2026-10-04, the owner: "what task I am not doing
 * fully, what is not doing even half"): each timed thing's average share of
 * its planned time (skips count 0), split into full / part / under half /
 * skipped, worst first, with the two lists called out.
 */
function HowFully({ stats, shown }: { stats: FocusStats; shown: boolean }) {
  const timed = stats.items.filter((item): item is FocusItemStats & { average: number } => item.average !== null);
  if (timed.length === 0) return null;
  const worstFirst = [...timed].sort((a, b) => a.average - b.average);
  const notFully = worstFirst.filter((item) => item.average >= 0.5 && item.average < 0.9);
  const underHalf = worstFirst.filter((item) => item.average < 0.5);
  const pct = (value: number) => Math.round(value * 100);
  return (
    <section className="ph-stats-card ph-fully">
      <header>
        <strong><Target size={16} weight="fill" /> How fully</strong>
        <span className="ph-stats-legend"><i data-k="full" /> full <i data-k="partial" /> part <i data-k="low" /> &lt;half <i data-k="skip" /> skipped</span>
      </header>
      {stats.time_kept !== null && (
        <p className="ph-fully-line">
          You put in <b><Num value={shown ? pct(stats.time_kept) : 0} />%</b> of the time you planned.
        </p>
      )}
      <ul className="ph-fully-list">
        {worstFirst.map((item, index) => (
          <li key={item.uid} style={{ "--i": index } as React.CSSProperties}>
            <span className="ph-fully-name">{item.title}</span>
            <span className="ph-fully-pct" data-level={item.average >= 0.9 ? "full" : item.average >= 0.5 ? "partial" : "low"}>{pct(item.average)}%</span>
            <span className="ph-fully-bar" data-shown={shown} aria-label={`${item.full} full, ${item.partial} part, ${item.low} under half, ${item.skipped} skipped`}>
              {item.full > 0 && <span data-k="full" style={{ flexGrow: item.full }} />}
              {item.partial > 0 && <span data-k="partial" style={{ flexGrow: item.partial }} />}
              {item.low > 0 && <span data-k="low" style={{ flexGrow: item.low }} />}
              {item.skipped > 0 && <span data-k="skip" style={{ flexGrow: item.skipped }} />}
            </span>
          </li>
        ))}
      </ul>
      {notFully.length > 0 && (
        <p className="ph-fully-call" data-k="partial">
          <b>Not doing fully</b>
          {notFully.map((item) => <span key={item.uid}>{item.title} · {pct(item.average)}%</span>)}
        </p>
      )}
      {underHalf.length > 0 && (
        <p className="ph-fully-call" data-k="low">
          <b>Not even half</b>
          {underHalf.map((item) => <span key={item.uid}>{item.title} · {pct(item.average)}%</span>)}
        </p>
      )}
      {notFully.length === 0 && underHalf.length === 0 && <p className="ph-fully-call" data-k="full"><b>Everything gets your full time.</b></p>}
    </section>
  );
}

function Tile({ icon, tone, label, value, unit, text, hot }: {
  icon: React.ReactNode;
  tone: string;
  label: string;
  value?: number;
  unit?: string;
  text?: string;
  hot?: boolean;
}) {
  return (
    <div className="ph-stats-tile" data-tone={tone} data-hot={hot || undefined}>
      <span className="ph-stats-tile-icon">{icon}</span>
      <span className="ph-stats-tile-label">{label}</span>
      <span className="ph-stats-tile-value">
        {text ?? <Num value={value ?? 0} />}
        {unit && <small>{unit}</small>}
      </span>
    </div>
  );
}
