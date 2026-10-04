"use client";

import * as React from "react";

import { API_BASE } from "@/lib/api";

import { samplePings, type Mood } from "./content";
import type { Answers } from "./state";
import { Cta, Quiet, StepFrame } from "./ui";
import type { AddedBlock } from "./weekPlan";

/**
 * Ask for notifications, explained first. The public app skips the launch
 * prompt (MainActivity) and asks here, through
 * `JarvisNotifications.requestPermission()`. Saying yes also switches on
 * pings for the blocks they just added: by default only task deadlines ping.
 */
function askSystem(): void {
  try {
    const bridge = window.JarvisNotifications as unknown as { requestPermission?: () => unknown } | undefined;
    if (typeof bridge?.requestPermission === "function") bridge.requestPermission();
  } catch {
    // The explanation stands on its own.
  }
  void fetch(`${API_BASE}/api/notifications/policy`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, college: true, routine: true, blocks: true, reminders: true }),
  })
    // Re-project the native alarm plan with the new policy.
    .then(() => window.dispatchEvent(new Event("jarvis-native-notifications-ready")))
    .catch(() => undefined);
}

export function NotifyStep({ answers, blocks, react, next }: {
  answers: Answers;
  blocks: AddedBlock[];
  react: (mood: Mood, line: string) => void;
  next: () => void;
}) {
  const call = answers.callMe.trim() || answers.name.trim().split(/\s+/)[0] || "";
  const first = blocks.find((block) => block.template !== "sleep" && block.template !== "free") ?? null;
  const pings = samplePings(answers.vibe, call, answers.enemy, first ? { name: first.name, emoji: first.emoji } : null);
  return (
    <StepFrame
      eyebrow="11 · Pings"
      title="Can I ping you?"
      sub="Before a block starts, when a streak's on the line, and when it's 1 a.m. and you're still scrolling."
      footer={
        <>
          <Cta
            onClick={() => {
              askSystem();
              react("love", "Deal. Only the pings that matter.");
              next();
            }}
          >
            Sounds good
          </Cta>
          <Quiet
            onClick={() => {
              react("calm", "No pressure. You can turn them on later.");
              next();
            }}
          >
            Maybe later
          </Quiet>
        </>
      }
    >
      <ul className="ob-pings" aria-label="Example notifications">
        {pings.map((ping, index) => (
          <li key={index} className="ob-ping" style={{ "--i": index } as React.CSSProperties}>
            <span className="ob-ping-icon" aria-hidden="true">{ping.emoji}</span>
            <span className="ob-ping-text">
              <span className="ob-ping-app">JARVIS <em>· {ping.when}</em></span>
              <span>{ping.text}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="ob-hint">No spam. No &ldquo;Dear Customer&rdquo;. Pinky promise.</p>
    </StepFrame>
  );
}
