"use client";

import * as React from "react";
import { ArrowCounterClockwise, Lightning, SignOut, Trash, UserCircle } from "@phosphor-icons/react";
import { toast } from "sonner";

import { haptic } from "@/components/phone/lib/haptics";
import { useNav } from "@/components/phone/PhoneContext";
import { Tap } from "@/components/phone/ui/Tap";
import { usePublic } from "./PublicContext";

/**
 * Settings → Account in JARVIS Public: who is signed in, the plan, Aura, sign
 * out, and deleting the account (Play requires deletion inside the app).
 */
/**
 * Redo setup: onboarding again (gender, vibe, your week...) without losing
 * anything already on the phone. Two taps, so it can't happen by accident.
 */
function RedoSetup() {
  const pub = usePublic();
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <div className="pub-card">
      <span className="pub-eyebrow"><ArrowCounterClockwise size={14} weight="bold" /> Your setup</span>
      <p>Answer the setup questions again. Your schedule, tasks and Lock-in history all stay.</p>
      <Tap
        className="pub-link"
        onClick={() => {
          if (!armed) {
            haptic("warning");
            setArmed(true);
            return;
          }
          haptic("heavy");
          pub.redoSetup();
        }}
        feel={false}
      >
        <ArrowCounterClockwise size={16} weight="bold" /> {armed ? "Tap again to start the setup" : "Redo setup"}
      </Tap>
    </div>
  );
}

export function AccountPage() {
  const pub = usePublic();
  const { push } = useNav();
  const [confirming, setConfirming] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  React.useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  if (!pub.session) {
    return (
      <div className="pub-locked">
        <span className="pub-locked-icon"><UserCircle size={30} weight="fill" /></span>
        <strong>You&apos;re using the planner without an account.</strong>
        <p>Sign in to unlock chat, voice and your plan&apos;s Aura.</p>
        <Tap className="pub-cta" onClick={pub.requestSignIn} feel="heavy" squish={0.94}>Sign in</Tap>
        <RedoSetup />
      </div>
    );
  }

  const remove = () => {
    if (!confirming) {
      haptic("warning");
      setConfirming(true);
      return;
    }
    setDeleting(true);
    void pub
      .deleteAccount()
      .then(() => toast("Account deleted", { description: "Your planner on this phone stays until you erase it in Local storage." }))
      .catch(() => toast.error("Couldn't delete the account", { description: "Check your connection and try again." }))
      .finally(() => setDeleting(false));
  };

  const me = pub.me;
  return (
    <div className="pub-account">
      <div className="pub-card">
        <span className="pub-eyebrow">Signed in</span>
        <strong>{pub.session.user.email ?? "Your account"}</strong>
      </div>
      <div className="pub-card" data-tone="lime">
        <span className="pub-eyebrow"><Lightning size={14} weight="fill" /> {me ? me.plan.name : "Plan"}</span>
        <strong className="pub-account-aura">{me ? `${Math.floor(me.aura.balance)} Aura` : "…"}</strong>
        {me && <p>Refills on {new Date(me.period.end).toLocaleDateString(undefined, { day: "numeric", month: "short" })}. Today: {Math.round(me.limits.spent_today_aura)} of {me.limits.daily_cap_aura} used.</p>}
        <Tap className="pub-cta" onClick={() => push({ kind: "plans" })} feel="heavy" squish={0.94}>See plans</Tap>
      </div>
      <Tap
        className="pub-link"
        onClick={() => {
          haptic("toggle-off");
          void pub.signOut().then(() => toast("Signed out", { description: "Your planner stays on this phone." }));
        }}
        feel={false}
      >
        <SignOut size={16} weight="bold" /> Sign out
      </Tap>
      <RedoSetup />
      <Tap className="pub-link pub-danger" disabled={deleting} onClick={remove} feel={false}>
        <Trash size={16} weight="bold" /> {deleting ? "Deleting…" : confirming ? "Tap again to delete for good" : "Delete account"}
      </Tap>
    </div>
  );
}
