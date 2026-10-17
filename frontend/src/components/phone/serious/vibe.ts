/**
 * JARVIS's voice in Lock-in, by the vibe picked in onboarding (roadmap:
 * "roast and hype personality", 2026-10-17). Hype friend hypes, Strict coach
 * roasts a skip, Chill keeps it light, Calm monk keeps it still. The personal
 * app has no onboarding profile and speaks as Hype. Words are gender-neutral
 * on purpose ("her" never hears "bro").
 */
import type { Vibe } from "@/lib/profile";

export function vibeOrDefault(vibe: Vibe | null | undefined): Vibe {
  return vibe === "coach" || vibe === "chill" || vibe === "monk" || vibe === "hype" ? vibe : "hype";
}

/** The evening check-in's line. */
export function checkinLine(vibe: Vibe, t: { done: number; total: number; slipped: string[]; ahead: number; weekMissed: number }): string {
  const { done, total, slipped, ahead, weekMissed } = t;
  const names = slipped.slice(0, 2).join(" and ");
  if (!total) {
    if (weekMissed) {
      const them = weekMissed === 1 ? "it" : "them";
      return {
        hype: `Nothing serious today, but ${weekMissed} from this week slipped. Let's fit ${them} back in!`,
        coach: `Free day today, yet ${weekMissed} from this week are still undone. Fix ${them}.`,
        chill: `Quiet day. ${weekMissed} from this week slipped; want to find ${them} a new slot?`,
        monk: `A still day. ${weekMissed} from this week wait for you. Return to ${them} when ready.`,
      }[vibe];
    }
    return {
      hype: "No Lock-ins today. Recharge, then we go again.",
      coach: "Nothing locked in today. Tomorrow we lock in. Plan it now.",
      chill: "No Lock-ins today. Rest counts too.",
      monk: "A quiet day. Rest is part of the practice.",
    }[vibe];
  }
  if (slipped.length) {
    const it = slipped.length === 1 ? "it" : "them";
    return {
      hype: `${done} of ${total} locked in. ${names} slipped, but we're not folding. Fit ${it} back in?`,
      coach: `${done} of ${total}. ${names}? Skipped. Excuses don't count. Fit ${it} back in, now.`,
      chill: `${done} of ${total}. ${names} slipped, no stress. Let's find ${it} a new slot.`,
      monk: `${done} of ${total}. ${names} slipped. Notice it, don't dwell. Begin again.`,
    }[vibe];
  }
  if (ahead) {
    return {
      hype: `${done} of ${total} so far. ${ahead} still ahead. Finish strong!`,
      coach: `${done} of ${total}. ${ahead} still ahead. Don't you dare stop now.`,
      chill: `${done} of ${total} so far. ${ahead} more tonight, no rush.`,
      monk: `${done} of ${total}. ${ahead} remain. One at a time.`,
    }[vibe];
  }
  return {
    hype: `Clean sweep! ${done} for ${total}, zero skips. Main character stuff.`,
    coach: `${done} of ${total}, no skips. That's the standard now. Keep it.`,
    chill: `All ${total} done. Proud of you. Rest easy tonight.`,
    monk: `All ${total} done. The work is done. Rest.`,
  }[vibe];
}

/** Today's "it slipped" card, under the title. */
export function slippedLine(vibe: Vibe): string {
  return {
    hype: "One miss doesn't kill the week. JARVIS will find it a new slot.",
    coach: "You skipped it. Own it, then fix it. JARVIS has a slot ready.",
    chill: "It happens. Let JARVIS find it a new slot, no stress.",
    monk: "It slipped. Make room for it again, gently.",
  }[vibe];
}

/** Weekly Wrapped's verdict, from the share of the plan kept. */
export function wrappedVerdict(vibe: Vibe, kept: number | null): string {
  if (kept === null) {
    return {
      hype: "No Lock-ins this week. Next week we go!",
      coach: "Nothing locked in this week. That changes Monday.",
      chill: "A free week. Lock in one thing next week?",
      monk: "An empty week. Begin with one thing.",
    }[vibe];
  }
  if (kept >= 0.9) {
    return { hype: "Unstoppable week.", coach: "That's the standard. Repeat it.", chill: "Beautiful week. Keep it going.", monk: "A steady week. Stay steady." }[vibe];
  }
  if (kept >= 0.6) {
    return { hype: "Solid week. Next one, all of it.", coach: "Decent. Decent isn't the goal.", chill: "Good week. A little more next time?", monk: "Most of it done. Return to the rest." }[vibe];
  }
  return { hype: "Rough week. The comeback starts Monday.", coach: "That was soft. Monday we fix it.", chill: "Tough week. Fresh start Monday, no guilt.", monk: "A hard week. Begin again." }[vibe];
}
