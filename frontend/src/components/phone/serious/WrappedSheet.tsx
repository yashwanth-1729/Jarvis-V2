"use client";

/**
 * "Your week, wrapped": the week's honest numbers as a story card to post
 * (roadmap: Weekly Wrapped, 2026-10-17). It opens from Stats and from Sunday's
 * check-in, shows the card it will share, and shares it.
 */
import * as React from "react";
import { ShareNetwork } from "@phosphor-icons/react";
import { toast } from "sonner";

import { usePublicOptional } from "@/components/public/PublicContext";
import { fetchFocusStats, fetchFocusWeek } from "@/lib/focus";
import { haptic } from "../lib/haptics";
import { Sheet } from "../ui/Sheet";
import { Tap } from "../ui/Tap";
import { vibeOrDefault, wrappedVerdict } from "./vibe";
import { renderWrapped, shareWrapped, type WrappedData } from "./wrapped";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function WrappedSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pub = usePublicOptional();
  const [data, setData] = React.useState<WrappedData | null>(null);
  const [blob, setBlob] = React.useState<Blob | null>(null);
  const [url, setUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [sharing, setSharing] = React.useState(false);
  const profile = pub?.profile ?? null;

  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    let made: string | null = null;
    setFailed(false);
    setData(null);
    setUrl(null);
    void (async () => {
      try {
        const [week, stats] = await Promise.all([fetchFocusWeek(), fetchFocusStats(7)]);
        const thisWeek = stats.series.filter((day) => day.date >= week.week_of);
        const best = thisWeek.reduce<(typeof thisWeek)[number] | null>((top, day) => (day.minutes > (top?.minutes ?? 0) ? day : top), null);
        const top = [...stats.items].sort((a, b) => b.minutes - a.minutes)[0];
        const next: WrappedData = {
          weekLabel: `WEEK OF ${new Date(`${week.week_of}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }).toUpperCase()}`,
          minutes: week.this.minutes,
          delta: week.last.minutes > 0 ? week.this.minutes - week.last.to_date : null,
          kept: week.this.kept,
          done: week.this.done,
          skipped: week.this.skipped,
          streak: week.streak,
          bestDay: best && best.minutes > 0 ? { label: DAYS[new Date(`${best.date}T12:00:00`).getDay()], minutes: best.minutes } : null,
          top: top && top.minutes > 0 ? { title: top.title, minutes: top.minutes } : null,
          verdict: wrappedVerdict(vibeOrDefault(profile?.vibe), week.this.kept),
          name: profile ? (profile.callMe || profile.name || "").trim() : "",
        };
        const png = await renderWrapped(next, document.querySelector(".ph"));
        if (!alive) return;
        setData(next);
        setBlob(png);
        if (png) {
          made = URL.createObjectURL(png);
          setUrl(made);
        }
        haptic("success");
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [open, profile]);

  const share = async () => {
    if (!data || sharing) return;
    setSharing(true);
    const outcome = await shareWrapped(blob, data);
    setSharing(false);
    if (outcome === "copied") toast("Copied", { description: "Your week's line is on the clipboard." });
    else if (outcome === "downloaded") toast("Saved", { description: "jarvis-wrapped.png" });
    else if (outcome === "failed") toast.error("Couldn't share that", { description: "Try again in a moment." });
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Your week, wrapped"
      eyebrow="WEEKLY WRAPPED"
      tone="ember"
      footer={
        <Tap className="ph-btn ph-btn-ember ph-btn-wide" disabled={!data || sharing} onClick={() => void share()} feel="heavy" squish={0.96}>
          <ShareNetwork size={18} weight="bold" /> {sharing ? "Sharing…" : "Share it"}
        </Tap>
      }
    >
      <div className="ph-wrapped">
        {failed ? (
          <p className="ph-cu-problem">Couldn&apos;t load your week. Check that the assistant is running, then try again.</p>
        ) : url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="ph-wrapped-card" src={url} alt="Your week as a story card" />
        ) : (
          <div className="ph-wrapped-loading" role="status">Wrapping your week…</div>
        )}
      </div>
    </Sheet>
  );
}
