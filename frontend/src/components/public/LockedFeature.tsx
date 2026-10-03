"use client";

import * as React from "react";
import { LockSimple, Sparkle } from "@phosphor-icons/react";
import { toast } from "sonner";

import { UNLOCKED_BY, PLANS, type Feature } from "@/lib/gateway";
import { haptic } from "@/components/phone/lib/haptics";
import { emitFx } from "@/components/phone/fx/fxBus";
import { useNav } from "@/components/phone/PhoneContext";
import { Tap } from "@/components/phone/ui/Tap";
import { usePublic } from "./PublicContext";

const COPY: Partial<Record<Feature, { title: string; why: string }>> = {
  lockin: { title: "Lock-in is a power-up.", why: "Start it, finish it, and every skip gets counted. The streaks hit different." },
  voice_en: { title: "Voice is a power-up.", why: "Talk to JARVIS like a friend: hands-free planning, pep talks, quick answers." },
  voice_te: { title: "Telugu voice is a power-up.", why: "JARVIS in your language, out loud." },
  news: { title: "News Drops are a power-up.", why: "60 seconds of what's happening in what you love, every morning." },
};

/** What a locked feature shows: the pitch, the trial if there is one, the plans. */
export function LockedFeature({ feature }: { feature: Feature }) {
  const pub = usePublic();
  const { push } = useNav();
  const [busy, setBusy] = React.useState(false);
  const copy = COPY[feature] ?? { title: "That's a power-up.", why: "" };
  const plan = PLANS.find((item) => item.id === UNLOCKED_BY[feature]);
  const trial = feature === "lockin" && pub.session && pub.me?.trial.lockin.available;

  const startTrial = async () => {
    setBusy(true);
    const ok = await pub.startTrial();
    setBusy(false);
    if (ok) {
      haptic("success");
      emitFx("success", { x: 0.5, y: 0.4 });
      toast.success("3 days of Lock-in, on us", { description: "Make them count." });
    } else {
      haptic("warning");
      toast.error("Couldn't start the trial", { description: "Check your connection and try again." });
    }
  };

  return (
    <div className="pub-locked" data-feature={feature}>
      <span className="pub-locked-icon"><LockSimple size={30} weight="fill" /></span>
      <strong>{copy.title}</strong>
      {copy.why && <p>{copy.why}</p>}
      {!pub.session ? (
        <Tap className="pub-cta" onClick={pub.requestSignIn} feel="heavy" squish={0.94}>Sign in to unlock</Tap>
      ) : trial ? (
        <Tap className="pub-cta" onClick={() => void startTrial()} disabled={busy} feel={false} squish={0.94}>
          <Sparkle size={18} weight="fill" /> {busy ? "Starting…" : "Start free 3-day trial"}
        </Tap>
      ) : (
        <Tap className="pub-cta" onClick={() => push({ kind: "plans", highlight: plan?.id })} feel="heavy" squish={0.94}>
          Unlock with {plan?.name ?? "a plan"}{plan?.price ? ` · ₹${plan.price}` : ""}
        </Tap>
      )}
    </div>
  );
}
