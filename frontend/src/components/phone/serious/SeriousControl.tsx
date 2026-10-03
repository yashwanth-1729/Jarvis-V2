"use client";

/**
 * The serious-mode button that lives on a task row or a timeline block:
 * Start → (live timer) Stop for a session item, one-tap Done for a quick one,
 * a burnt-in "Locked" once finished. Starting ignites (orange shockwave,
 * embers, a screen-edge flash); finishing forges (gold sparks). A serious task
 * finished here is finished on the board too, with the board's Undo.
 */
import * as React from "react";
import { Check, Fire, LockSimple, Stop } from "@phosphor-icons/react";
import { toast } from "sonner";

import { finishFocus, startFocus } from "@/lib/focus";
import { parseLocal } from "@/lib/utils";
import type { Task } from "@/types";
import { usePublicOptional } from "@/components/public/PublicContext";
import { emitFx } from "../fx/fxBus";
import { haptic } from "../lib/haptics";
import { useFinishAction, useNav, useNow } from "../PhoneContext";
import { Tap } from "../ui/Tap";
import { emberBurst } from "./embers";
import { useSerious } from "./SeriousContext";

/** "missed": its time ended (or the task is overdue) with no Done. */
export type SeriousRowState = "pending" | "running" | "done" | "missed";

/** The serious state of one occurrence, or null when it is not serious. */
export function useSeriousState(uid: string | null | undefined, occurrence: string, ended = false): SeriousRowState | null {
  const serious = useSerious();
  if (!serious || !uid || !serious.items.has(uid)) return null;
  const event = serious.eventFor(uid, occurrence);
  return event?.status === "done" ? "done" : event?.status === "running" ? "running" : ended ? "missed" : "pending";
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
  const state: SeriousRowState = event?.status === "done" ? "done" : event?.status === "running" ? "running" : ended ? "missed" : "pending";

  if (pub && !pub.has("lockin")) {
    return (
      <span className="ph-serious-ctl">
        <Tap className="ph-serious-btn" data-kind="locked" aria-label="Unlock Lock-in" onClick={() => push({ kind: "plans", highlight: "side_quest" })} feel="select">
          <LockSimple size={15} weight="fill" />
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
          <Fire size={15} weight="fill" /> Start
        </Tap>
      ) : (
        <Tap className="ph-serious-btn" data-kind="done" disabled={busy} onClick={(e) => void finish(e.currentTarget)} feel={false} squish={0.9} aria-label={`Done: ${item.title}`}>
          <Check size={15} weight="bold" /> Done
        </Tap>
      )}
    </span>
  );
}
