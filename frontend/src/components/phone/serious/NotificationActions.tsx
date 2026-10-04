"use client";

/**
 * What a tap on a Lock-in notification does once the app is open ("JARVIS
 * reaches out first", 2026-10-04):
 * - Start begins that session, with the stamp and the sparks;
 * - Done finishes a one-tap block;
 * - Check in opens the evening check-in, and JARVIS says it.
 *
 * A tap can launch the app cold, while the on-device backend is still
 * booting, so Start and Done retry for a little while before giving up.
 */
import * as React from "react";
import { toast } from "sonner";

import { usePublicOptional } from "@/components/public/PublicContext";
import { ApiError } from "@/lib/api";
import { finishFocus, startFocus } from "@/lib/focus";
import { subscribeNotificationActions, type NotificationAction } from "@/lib/notificationActions";
import { emitFx } from "../fx/fxBus";
import { haptic } from "../lib/haptics";
import { useNav } from "../PhoneContext";
import { openCheckIn } from "./catchUp";
import { lockinStamp } from "./embers";

const ATTEMPTS = 10;
const RETRY_MS = 2500;

async function act(action: NotificationAction & { uid: string }): Promise<void> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const event = action.verb === "start"
        ? await startFocus(action.uid, action.occurrence)
        : await finishFocus(action.uid, action.occurrence);
      const center = { x: window.innerWidth / 2, y: window.innerHeight * 0.42 };
      if (action.verb === "start") {
        haptic("heavy");
        emitFx("ignite", center);
        lockinStamp("start", event.title);
      } else {
        haptic("success");
        emitFx("forge", center);
        lockinStamp("done", event.title);
      }
      return;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        toast("That one isn't serious any more.");
        return;
      }
      if (attempt < ATTEMPTS) await new Promise((resolve) => window.setTimeout(resolve, RETRY_MS));
    }
  }
  haptic("warning");
  toast.error(action.verb === "start" ? "Couldn't start that" : "Couldn't save that", { description: "Open Lock-in and try again." });
}

export function NotificationActions() {
  const { go, push } = useNav();
  const pub = usePublicOptional();
  const latest = React.useRef({ go, push, pub });
  latest.current = { go, push, pub };

  React.useEffect(
    () =>
      subscribeNotificationActions((action) => {
        const { go: goTo, push: open, pub: edition } = latest.current;
        if (action.verb === "checkin") {
          goTo("today");
          window.setTimeout(() => openCheckIn({ speak: true }), 450);
          return;
        }
        if (!action.uid) return;
        if (edition && !edition.has("lockin")) {
          open({ kind: "plans", highlight: "side_quest" });
          return;
        }
        goTo("today");
        void act({ ...action, uid: action.uid });
      }),
    [],
  );

  return null;
}
