"use client";

/**
 * While a serious session runs: a bar above the dock on every screen, with
 * the timer and Stop, a heartbeat glow, and a beat rippling through the ember
 * background every couple of seconds. Tapping it opens Lock-in.
 */
import * as React from "react";
import { motion } from "framer-motion";
import { LockSimple, Stop } from "@phosphor-icons/react";
import { toast } from "sonner";

import { finishFocus } from "@/lib/focus";
import { emitFx } from "../fx/fxBus";
import { haptic } from "../lib/haptics";
import { useAppData, useFinishAction, useNav } from "../PhoneContext";
import { Tap } from "../ui/Tap";
import { emberBurst, lockinStamp } from "./embers";
import { Pulse } from "./Pulse";
import { Elapsed } from "./SeriousControl";
import { useSerious } from "./SeriousContext";

export function LockinBar({ hidden }: { hidden: boolean }) {
  const serious = useSerious();
  const { push } = useNav();
  const { app } = useAppData();
  const finishTask = useFinishAction();
  const bar = React.useRef<HTMLDivElement>(null);
  const [busy, setBusy] = React.useState(false);
  const running = serious?.running ?? null;

  // The heartbeat: a soft red ripple from the bar through the background.
  React.useEffect(() => {
    if (!running || hidden) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") emitFx("beat", bar.current);
    }, 2400);
    return () => window.clearInterval(timer);
  }, [running, hidden]);

  if (!running || hidden) return null;
  const { item, event } = running;

  const stop = async (origin: HTMLElement) => {
    setBusy(true);
    try {
      await finishFocus(item.uid, event.occurrence);
      haptic("success");
      emitFx("forge", origin);
      emberBurst(origin, "forge");
      lockinStamp("done", item.title);
      const task = item.kind === "task" ? app.state?.tasks.find((candidate) => candidate.uid === item.uid) : undefined;
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
    <motion.div
      ref={bar}
      className="ph-lockin-bar"
      initial={{ opacity: 0, transform: "translateY(24px) scale(0.96)" }}
      animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
      exit={{ opacity: 0, transform: "translateY(24px) scale(0.96)" }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      role="status"
      aria-live="polite"
    >
      <Pulse className="ph-lockin-bar-pulse" />
      <span className="ph-lockin-bar-flame" aria-hidden="true"><LockSimple size={20} weight="fill" /></span>
      <Tap className="ph-lockin-bar-body" onClick={() => push({ kind: "focus" })} feel="select" aria-label={`Locked in on ${item.title}. Open Lock-in`}>
        <small>LOCKED IN</small>
        <strong>{item.title}</strong>
      </Tap>
      <Elapsed since={event.started_at} />
      <Tap className="ph-serious-btn" data-kind="stop" disabled={busy} onClick={(e) => void stop(e.currentTarget)} feel={false} squish={0.9} aria-label={`Stop: ${item.title}`}>
        <Stop size={15} weight="fill" /> Stop
      </Tap>
    </motion.div>
  );
}
