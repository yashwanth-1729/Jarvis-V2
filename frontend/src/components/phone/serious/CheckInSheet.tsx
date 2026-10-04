"use client";

/**
 * The evening check-in ("JARVIS reaches out first"): today's Lock-ins at a
 * glance, one honest line, and the way back in for anything that slipped. The
 * check-in notification's button opens it, and JARVIS reads the line out when
 * voice is available.
 */
import * as React from "react";
import { ArrowBendUpRight, Check, LockSimple, Moon, SpeakerHigh, Timer, X } from "@phosphor-icons/react";

import { usePublicOptional } from "@/components/public/PublicContext";
import { playAudio, stopAudio, synthesize } from "@/lib/voice";
import { occurrences } from "../lib/derive";
import { clock } from "../lib/time";
import { useAppData, useNow } from "../PhoneContext";
import { Sheet } from "../ui/Sheet";
import { Tap } from "../ui/Tap";
import { openCatchUp } from "./catchUp";
import { emberBurst } from "./embers";
import { seriousStateOf, type SeriousRowState } from "./SeriousControl";
import { dayKey, useSerious } from "./SeriousContext";

interface Row {
  key: string;
  title: string;
  start: number;
  state: SeriousRowState;
}

function lineFor(rows: Row[], weekMissed: number): string {
  const done = rows.filter((row) => row.state === "done").length;
  const slipped = rows.filter((row) => row.state === "missed");
  const ahead = rows.filter((row) => row.state === "pending" || row.state === "running").length;
  if (!rows.length) {
    return weekMissed
      ? `Nothing serious today. ${weekMissed} from this week still slipped. Want to fit ${weekMissed === 1 ? "it" : "them"} back in?`
      : "No Lock-ins today. Rest counts too.";
  }
  if (!slipped.length && !ahead) return `Clean sweep. ${done} of ${rows.length}, no skips. That's how it's done.`;
  if (!slipped.length) return `${done} of ${rows.length} so far. ${ahead} still ahead tonight. Finish it.`;
  const names = slipped.slice(0, 2).map((row) => row.title).join(" and ");
  return `${done} of ${rows.length} locked in. ${names} slipped. No drama: let's fit ${slipped.length === 1 ? "it" : "them"} back in.`;
}

export function CheckInSheet({ open, speak, onClose }: { open: boolean; speak: boolean; onClose: () => void }) {
  const { app } = useAppData();
  const serious = useSerious();
  const pub = usePublicOptional();
  const now = useNow(30_000);
  const [playing, setPlaying] = React.useState(false);
  const score = React.useRef<HTMLElement>(null);
  const today = dayKey(now);

  const rows = React.useMemo<Row[]>(() => {
    if (!serious) return [];
    return occurrences(app.state?.today ?? [])
      .filter((item) => item.event.uid && serious.items.has(item.event.uid))
      .map((item) => ({
        key: `${item.event.uid}-${item.start}`,
        title: item.event.event_name,
        start: item.start,
        state: seriousStateOf(serious.eventFor(item.event.uid as string, dayKey(new Date(item.start)))?.status, item.end <= now.getTime()),
      }));
  }, [app.state?.today, serious, now]);

  const weekMissed = serious?.missed.length ?? 0;
  const done = rows.filter((row) => row.state === "done").length;
  const clean = rows.length > 0 && rows.every((row) => row.state === "done" || row.state === "moved");
  const line = lineFor(rows, weekMissed);
  const canSpeak = !pub || pub.has("voice_en");

  const hear = React.useCallback(async () => {
    if (!canSpeak) return;
    try {
      setPlaying(true);
      const clip = await synthesize(line);
      // Plays at once; a blocked autoplay just ends it.
      playAudio(clip, () => setPlaying(false));
    } catch {
      setPlaying(false);
    }
  }, [canSpeak, line]);

  // Opened from the notification: JARVIS says it, if the phone lets audio
  // start without a tap (if not, the speaker button is right there).
  const spoken = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!open || !speak || spoken.current === today) return;
    spoken.current = today;
    void hear();
  }, [open, speak, today, hear]);

  React.useEffect(() => {
    if (open && clean && score.current) emberBurst(score.current, "forge");
  }, [open, clean]);

  const close = () => {
    stopAudio();
    setPlaying(false);
    onClose();
  };

  const footer = weekMissed > 0 && (!pub || pub.has("lockin")) ? (
    <Tap
      className="ph-btn ph-btn-ember ph-btn-wide"
      onClick={() => {
        close();
        window.setTimeout(openCatchUp, 320);
      }}
      feel="heavy"
    >
      <ArrowBendUpRight size={18} weight="bold" /> Fit {weekMissed === 1 ? "it" : `${weekMissed}`} back in
    </Tap>
  ) : (
    <Tap className="ph-btn ph-btn-wide" onClick={close}>Done for today</Tap>
  );

  return (
    <Sheet open={open} onClose={close} title="Daily check-in" eyebrow={`TONIGHT · ${now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).toUpperCase()}`} tone="ember" footer={footer}>
      <div className="ph-ci">
        <div className="ph-ci-score" data-clean={clean}>
          <strong ref={score}>{done}</strong>
          <span>/{rows.length}</span>
          <small>{rows.length ? "locked today" : "nothing serious today"}</small>
        </div>

        <p className="ph-cu-say ph-ci-say">
          <Moon size={16} weight="fill" aria-hidden="true" />
          <span>{line}</span>
          {canSpeak && (
            <Tap
              className="ph-ci-hear"
              data-playing={playing}
              aria-label={playing ? "Stop" : "Hear it"}
              onClick={() => {
                if (playing) {
                  stopAudio();
                  setPlaying(false);
                } else void hear();
              }}
              feel="select"
            >
              <SpeakerHigh size={17} weight="fill" />
            </Tap>
          )}
        </p>

        {rows.length > 0 && (
          <ul className="ph-ci-list">
            {rows.map((row) => (
              <li key={row.key} data-state={row.state}>
                <span className="ph-ci-mark" aria-hidden="true">
                  {row.state === "done" ? <Check size={15} weight="bold" />
                    : row.state === "running" ? <Timer size={15} weight="fill" />
                      : row.state === "missed" ? <X size={14} weight="bold" />
                        : row.state === "moved" ? <ArrowBendUpRight size={14} weight="bold" />
                          : <LockSimple size={13} weight="fill" />}
                </span>
                <strong>{row.title}</strong>
                <span className="ph-ci-time">{row.state === "moved" ? "moved" : clock(new Date(row.start))}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
