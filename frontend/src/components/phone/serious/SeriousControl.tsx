"use client";

/**
 * The serious-mode button that lives on a task row or a timeline block:
 * Start → (live timer) Stop for a session item, one-tap Done for a quick one,
 * a "Locked" chip once finished. Starting slams a "LOCKED IN" stamp over a
 * black-red flash with crimson sparks; finishing stamps "NO SKIP." with
 * white-hot sparks. A serious task
 * finished here is finished on the board too, with the board's Undo.
 */
import * as React from "react";
import { ArrowBendUpRight, Check, LockSimple, Stop } from "@phosphor-icons/react";
import { toast } from "sonner";

import { finishFocus, startFocus } from "@/lib/focus";
import { parseLocal } from "@/lib/utils";
import type { Task } from "@/types";
import { usePublicOptional } from "@/components/public/PublicContext";
import { emitFx } from "../fx/fxBus";
import { haptic } from "../lib/haptics";
import { useFinishAction, useNav, useNow } from "../PhoneContext";
import { Tap } from "../ui/Tap";
import { emberBurst, lockinStamp } from "./embers";
import { useSerious } from "./SeriousContext";

/**
 * "missed": its time ended (or the task is overdue) with no Done.
 * "moved": it slipped, and a catch-up session now covers it.
 */
export type SeriousRowState = "pending" | "running" | "done" | "missed" | "moved";

/** One occurrence's state from its latest event (and whether its time is over). */
export function seriousStateOf(status: string | undefined, ended: boolean): SeriousRowState {
  if (status === "done" || status === "running" || status === "moved") return status;
  return ended ? "missed" : "pending";
}

/** The serious state of one occurrence, or null when it is not serious. */
export function useSeriousState(uid: string | null | undefined, occurrence: string, ended = false): SeriousRowState | null {
  const serious = useSerious();
  if (!serious || !uid || !serious.items.has(uid)) return null;
  return seriousStateOf(serious.eventFor(uid, occurrence)?.status, ended);
}

export function Elapsed({ since }: { since: string | null }) {
  const now = useNow(1000);
  const start = parseLocal(since);
  const seconds = start ? Math.max(0, Math.floor((now.getTime() - start.getTime()) / 1000)) : 0;
  const p = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(seconds / 3600);
  return <span className="ph-serious-timer">{h ? `${h}:` : ""}{p(Math.floor((seconds % 3600) / 60))}:{p(seconds % 60)}</span>;
}

export function SeriousControl({ uid, occurrence, task, ended = false }: { uid: string; occurrence: string; task?: Task; ended?: boolean }) {
  const serious = useSerious();
  const pub = usePublicOptional();
  const finishTask = useFinishAction();
  const { push } = useNav();
  const [busy, setBusy] = React.useState(false);
  const item = serious?.items.get(uid);
  if (!serious || !item) return null;
  const event = serious.eventFor(uid, occurrence);
  const state = seriousStateOf(event?.status, ended);

  if (pub && !pub.has("lockin")) {
    // Still a Start, so the feature is visible; it leads to the plans.
    return (
      <span className="ph-serious-ctl">
        <Tap className="ph-serious-btn" data-kind="start" data-locked="true" aria-label={`Start ${item.title}: unlock Lock-in`} onClick={() => push({ kind: "plans", highlight: "side_quest" })} feel="select" squish={0.9}>
          <LockSimple size={15} weight="fill" /> Start
        </Tap>
      </span>
    );
  }

  const start = async (origin: HTMLElement) => {
    setBusy(true);
    try {
      await startFocus(uid, occurrence);
      haptic("heavy");
      emitFx("ignite", origin);
      emberBurst(origin, "ignite");
      lockinStamp("start", item.title);
    } catch {
      haptic("warning");
      toast.error("Couldn't start", { description: "Is the assistant runtime running?" });
    } finally {
      setBusy(false);
    }
  };

  const finish = async (origin: HTMLElement) => {
    setBusy(true);
    try {
      await finishFocus(uid, occurrence);
      haptic("success");
      emitFx("forge", origin);
      emberBurst(origin, "forge");
      lockinStamp("done", item.title);
      if (task) finishTask(task, origin);
      else toast.success("Locked in", { description: `${item.title}: done, no skip.` });
    } catch {
      haptic("warning");
      toast.error("Couldn't save that", { description: "Try again in a moment." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="ph-serious-ctl" data-state={state}>
      {state === "done" ? (
        <span className="ph-serious-done"><Check size={14} weight="bold" /> Locked</span>
      ) : state === "moved" ? (
        // Caught up elsewhere this week: the catch-up block carries the Start.
        <span className="ph-serious-moved"><ArrowBendUpRight size={14} weight="bold" /> Moved</span>
      ) : state === "running" ? (
        <>
          <Elapsed since={event?.started_at ?? null} />
          <Tap className="ph-serious-btn" data-kind="stop" disabled={busy} onClick={(e) => void finish(e.currentTarget)} feel={false} squish={0.9} aria-label={`Stop: ${item.title}`}>
            <Stop size={15} weight="fill" /> Stop
          </Tap>
        </>
      ) : state === "missed" ? (
        // Its time is over: no Start any more, but owning it late still counts.
        <Tap className="ph-serious-btn" data-kind="done" disabled={busy} onClick={(e) => void finish(e.currentTarget)} feel={false} squish={0.9} aria-label={`Did it: ${item.title}`}>
          <Check size={15} weight="bold" /> Did it
        </Tap>
      ) : item.mode === "session" ? (
        <Tap className="ph-serious-btn" data-kind="start" disabled={busy} onClick={(e) => void start(e.currentTarget)} feel={false} squish={0.9} aria-label={`Start: ${item.title}`}>
          <LockSimple size={15} weight="fill" /> Start
        </Tap>
      ) : (
        <Tap className="ph-serious-btn" data-kind="done" disabled={busy} onClick={(e) => void finish(e.currentTarget)} feel={false} squish={0.9} aria-label={`Done: ${item.title}`}>
          <Check size={15} weight="bold" /> Done
        </Tap>
      )}
    </span>
  );
}
