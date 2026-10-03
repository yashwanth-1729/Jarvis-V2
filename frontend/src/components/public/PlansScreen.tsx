"use client";

import * as React from "react";
import { CaretLeft, Check, Lightning } from "@phosphor-icons/react";
import { toast } from "sonner";

import { PLANS, type PlanId } from "@/lib/gateway";
import { haptic } from "@/components/phone/lib/haptics";
import { emitFx } from "@/components/phone/fx/fxBus";
import { useNav } from "@/components/phone/PhoneContext";
import { Tap } from "@/components/phone/ui/Tap";
import { usePublic } from "./PublicContext";

/**
 * The plans, loud on purpose. Two uses: the soft paywall right after sign-in
 * (`intro`, always skippable) and a layer opened from the Aura chip or a
 * locked feature (`layer`).
 *
 * Buying goes through Google Play Billing, which arrives with the Play Store
 * release; until then a tap says so instead of pretending.
 */
export function PlansScreen({ mode, highlight, onDone }: { mode: "intro" | "layer"; highlight?: PlanId; onDone?: () => void }) {
  const pub = usePublic();
  const nav = useNav();
  const current = (pub.me?.plan.id ?? "spawn") as PlanId;
  const close = () => {
    if (mode === "intro") onDone?.();
    else nav.pop();
  };

  const pick = (id: PlanId) => {
    if (id === current) return;
    haptic("heavy");
    emitFx("heavy", null);
    toast("Payments open with the Play Store release", {
      description: "You're on the early list. Your plan unlocks the moment it's live.",
    });
  };

  return (
    <section className="pub-screen pub-plans" data-mode={mode} aria-label="Plans">
      <header className="pub-plans-head">
        {mode === "layer" && (
          <Tap className="ph-icon-btn" aria-label="Back" onClick={close} feel="select">
            <CaretLeft size={22} weight="bold" />
          </Tap>
        )}
        <span className="pub-eyebrow"><Lightning size={14} weight="fill" /> Power-ups</span>
        <h1 className="pub-title">{mode === "intro" ? "Pick your power-up." : "Level up."}</h1>
        {pub.me && (
          <p className="pub-sub">
            You&apos;re on <b>{pub.me.plan.name}</b> with <b>{Math.floor(pub.me.aura.balance)} Aura</b> left.
          </p>
        )}
      </header>

      <ol className="pub-plan-list">
        {PLANS.map((plan, index) => {
          const isCurrent = plan.id === current;
          return (
            <li key={plan.id} className="pub-plan" data-tone={plan.tone} data-current={isCurrent || undefined} data-hot={plan.id === highlight || undefined} style={{ "--i": index } as React.CSSProperties}>
              <div className="pub-plan-top">
                <strong className="pub-plan-name">{plan.name}</strong>
                <span className="pub-plan-price">{plan.price ? <>₹{plan.price}<small>/mo</small></> : "Free"}</span>
              </div>
              <p className="pub-plan-tag">{plan.tagline}</p>
              <ul className="pub-plan-adds">
                {plan.adds.map((line) => (
                  <li key={line}><Check size={14} weight="bold" /> {line}</li>
                ))}
              </ul>
              <Tap className="pub-plan-cta" onClick={() => pick(plan.id)} disabled={isCurrent} feel={false} squish={0.95}>
                {isCurrent ? "Your plan" : plan.price ? `Get ${plan.name}` : "Stay free"}
              </Tap>
            </li>
          );
        })}
      </ol>

      <p className="pub-fine">1 Aura ≈ one message. Voice uses about 3 a minute. Unused plan Aura resets monthly.</p>
      {mode === "intro" && (
        <Tap className="pub-link pub-skip" onClick={close} feel="select">Maybe later</Tap>
      )}
    </section>
  );
}

