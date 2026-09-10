"use client";

/**
 * Conditions, arranged the way you actually read them.
 *
 * The hierarchy is the point. A weather site gives fifteen numbers equal weight
 * and lets you hunt; the one thing you asked for should be legible from across
 * the room. So: temperature enormous, condition beside it, location above,
 * everything else demoted to a quiet row underneath, forecast as a strip along
 * the bottom.
 *
 * The icons are drawn rather than fetched — nine shapes in SVG, sharing the
 * interface's accent, so they belong to JARVIS instead of looking like they
 * were pasted in from a weather app.
 */

import * as React from "react";

import { Metric } from "@/components/surfaces/SurfaceHost";
import type { WeatherData, WeatherIcon } from "@/lib/surfaces";
import { cn } from "@/lib/utils";

function Glyph({ icon, className }: { icon: WeatherIcon; className?: string }) {
  const stroke = "currentColor";
  const common = {
    fill: "none",
    stroke,
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const cloud = <path d="M7 18h9a3.5 3.5 0 0 0 .3-7A5 5 0 0 0 7 12.5 2.8 2.8 0 0 0 7 18Z" {...common} />;
  const drops = (n: number, y = 20) => (
    <>
      {Array.from({ length: n }).map((_, i) => (
        <path key={i} d={`M${9 + i * 3} ${y}v2.4`} {...common} />
      ))}
    </>
  );

  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      {icon === "clear" && (
        <>
          <circle cx="12" cy="12" r="4.2" {...common} />
          {Array.from({ length: 8 }).map((_, i) => {
            const a = (i * Math.PI) / 4;
            return (
              <path
                key={i}
                d={`M${12 + Math.cos(a) * 6.6} ${12 + Math.sin(a) * 6.6}L${
                  12 + Math.cos(a) * 8.6
                } ${12 + Math.sin(a) * 8.6}`}
                {...common}
              />
            );
          })}
        </>
      )}
      {icon === "partly-cloudy" && (
        <>
          <circle cx="9" cy="9" r="3.2" {...common} />
          {cloud}
        </>
      )}
      {icon === "cloudy" && cloud}
      {icon === "fog" && (
        <>
          {cloud}
          <path d="M5 21h14M7 23.5h10" {...common} />
        </>
      )}
      {icon === "drizzle" && (<>{cloud}{drops(3)}</>)}
      {icon === "rain" && (<>{cloud}{drops(4)}</>)}
      {icon === "showers" && (<>{cloud}{drops(3)}<path d="M18 20l-1.5 3" {...common} /></>)}
      {icon === "snow" && (
        <>
          {cloud}
          {Array.from({ length: 3 }).map((_, i) => (
            <g key={i}>
              <path d={`M${9.5 + i * 3} 20.2v2.6M${8.4 + i * 3} 20.9l2.2 1.2M${10.6 + i * 3} 20.9l-2.2 1.2`} {...common} />
            </g>
          ))}
        </>
      )}
      {icon === "thunder" && (
        <>
          {cloud}
          <path d="M13 19.5l-2.6 3.4h2.4l-1 2.6" {...common} />
        </>
      )}
    </svg>
  );
}

function dayName(iso: string, index: number): string {
  if (index === 0) return "Today";
  if (index === 1) return "Tomorrow";
  const parsed = new Date(`${iso}T00:00:00`);
  return Number.isNaN(parsed.getTime())
    ? iso
    : parsed.toLocaleDateString(undefined, { weekday: "short" });
}

/** Compass point from degrees — "NE" reads faster than "43°". */
function bearing(degrees: number): string {
  const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return points[Math.round(degrees / 45) % 8] ?? "—";
}

function clockOf(iso: string | null): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? "—"
    : parsed.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * A number, or a dash.
 *
 * Every figure in this panel used to go straight into `Math.round`, which
 * turns `undefined` into `NaN` and prints it. That is exactly what happened:
 * the panel can be opened from intent before any weather has been fetched, so
 * it rendered "NaN" in every field for the seconds before the tool answered.
 * A dash is honest about not knowing yet; NaN looks like a broken instrument.
 */
function figure(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(Math.round(value)) : "—";
}

export function WeatherSurface({
  data,
  detailed = false,
}: {
  data: WeatherData;
  /** The full instrument. Off by default — see the note above the compact
   *  readout for why the short answer is the default one. */
  detailed?: boolean;
}) {
  const unit = data.units?.temperature ?? "°C";
  const [selected, setSelected] = React.useState(0);
  const days = data.forecast ?? [];
  const day = days[selected];

  // The panel can open the moment the question is understood, which is a
  // second or two before any weather exists. That is worth keeping — it is
  // what makes the interface feel like it is listening — but it has to be
  // honest about it. Rendering the empty payload printed "NaN" into every
  // field, which does not read as "fetching", it reads as broken.
  const pending = typeof data.temperature !== "number" || !Number.isFinite(data.temperature);

  if (pending) {
    return (
      <div className="flex h-full flex-col gap-5 pt-1" aria-busy="true">
        <div>
          <p className="font-mono text-2xs uppercase tracking-[0.24em] text-ink-dim">
            {data.location || "Reading conditions"}
          </p>
          <div className="mt-3 flex items-start gap-5">
            <div className="min-w-0 flex-1 space-y-3">
              {/* Shaped like the answer it is about to become, so the panel
                  settles into its content instead of relaying itself out. */}
              <div className="h-[3.8rem] w-32 animate-breathe rounded-lg bg-surface-2/70" />
              <div className="h-4 w-40 animate-breathe rounded bg-surface-2/50" />
              <div className="h-3.5 w-28 animate-breathe rounded bg-surface-2/40" />
            </div>
            <div className="ml-auto h-24 w-24 shrink-0 animate-breathe rounded-full bg-surface-2/40" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[0, 1, 2, 3].map((slot) => (
            <div
              key={slot}
              className="h-[4.2rem] animate-breathe rounded-lg border border-line/60 bg-surface-1/40"
            />
          ))}
        </div>
        <p className="font-mono text-2xs text-ink-faint">Fetching conditions…</p>
      </div>
    );
  }

  // Selecting a forecast day swaps the headline to that day's figures. The
  // panel is meant to be interrogated, not just read — that is the whole
  // difference between an instrument and a picture of one.
  const showingToday = selected === 0;

  // Two readouts, not one with things hidden.
  //
  // Asked "what's the weather", the answer is a temperature and whether it is
  // going to rain. Pressure, wind bearing, sunrise and a five-day strip are
  // not that answer — they are a weather site's habit of giving fifteen
  // numbers equal weight and letting you hunt. The compact readout says the
  // two things, large; asking again, or asking for detail, opens the full one.
  if (!detailed) {
    const rain = days[0]?.rain_chance;
    return (
      <div className="flex h-full flex-col justify-center gap-1 py-2">
        <p className="font-mono text-2xs uppercase tracking-[0.24em] text-ink-dim">
          {data.place || data.location}
        </p>
        <div className="flex items-start gap-4">
          <div className="flex items-start">
            <span className="tnum text-[5.5rem] font-extralight leading-[0.82] tracking-tighter text-ink">
              {figure(data.temperature)}
            </span>
            <span className="mt-3 ml-1 font-mono text-xl text-ink-dim">{unit}</span>
          </div>
          <Glyph
            icon={data.icon}
            className={cn(
              "ml-auto mt-1 h-20 w-20 shrink-0",
              data.is_day ? "text-accent" : "text-accent/70",
            )}
          />
        </div>
        <p className="mt-1 text-base text-ink">{data.condition}</p>
        {typeof rain === "number" && (
          <p className="font-mono text-sm text-ink-dim">
            <span className="tnum text-accent">{figure(rain)}%</span> chance of rain
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-5 pt-1">
      <div>
        <p className="font-mono text-2xs uppercase tracking-[0.24em] text-ink-dim">
          {data.location}
        </p>

        <div className="mt-3 flex items-start gap-5">
          <div className="min-w-0">
            <div className="flex items-start">
              {/* Today shows the measured temperature. A forecast day has no
                  single temperature to show, so it shows its high — this used
                  to print the mean of high and low, which is a number that
                  does not exist and was never measured. */}
              <span className="tnum text-[4.5rem] font-light leading-[0.85] tracking-tighter text-ink">
                {figure(showingToday ? data.temperature : day?.high)}
              </span>
              <span className="mt-2 ml-1 font-mono text-lg text-ink-dim">{unit}</span>
            </div>
            <p className="mt-1.5 text-base text-ink">
              {showingToday ? data.condition : day?.condition}
            </p>
            {showingToday ? (
              <p className="text-sm text-ink-dim">
                Feels like {figure(data.feels_like)}
                {unit}
              </p>
            ) : (
              <p className="text-sm text-ink-dim">
                {figure(day?.low)}
                {unit} – {figure(day?.high)}
                {unit}
              </p>
            )}
          </div>

          <Glyph
            icon={showingToday ? data.icon : (day?.icon ?? "cloudy")}
            className={cn(
              "ml-auto h-24 w-24 shrink-0",
              data.is_day ? "text-accent" : "text-accent/70",
            )}
          />
        </div>
      </div>

      {/* Secondary metrics: present, but visibly subordinate. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric
          label="Humidity"
          value={data.humidity == null ? "—" : `${figure(data.humidity)}%`}
        />
        <Metric
          label="Wind"
          value={figure(data.wind_speed)}
          hint={`${data.units?.wind ?? "km/h"} ${bearing(data.wind_direction)}`}
        />
        <Metric label="Sunrise" value={clockOf(data.sunrise)} />
        <Metric label="Sunset" value={clockOf(data.sunset)} />
      </div>

      {days.length > 0 && (
        <div className="min-w-0">
          <p className="mb-2 font-mono text-[0.6rem] uppercase tracking-[0.22em] text-ink-faint">
            Forecast — select a day
          </p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {days.map((entry, index) => {
              const active = index === selected;
              return (
                <button
                  key={entry.date}
                  type="button"
                  onClick={() => setSelected(index)}
                  aria-pressed={active}
                  className={cn(
                    "flex min-h-[92px] min-w-[76px] shrink-0 flex-col items-center gap-1.5 rounded-lg border px-2.5 py-2.5",
                    "transition-colors duration-150",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                    active
                      ? "border-accent/45 bg-accent/10"
                      : "border-line/60 bg-surface-1/40 hover:border-accent/25 hover:bg-surface-2/50",
                  )}
                >
                  <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-ink-dim">
                    {dayName(entry.date, index)}
                  </span>
                  <Glyph icon={entry.icon} className="h-6 w-6 text-accent/85" />
                  <span className="tnum text-xs text-ink">
                    {figure(entry.high)}° / {figure(entry.low)}°
                  </span>
                  {entry.rain_chance > 0 && (
                    <span className="tnum text-[0.6rem] text-accent/80">
                      {entry.rain_chance}%
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
