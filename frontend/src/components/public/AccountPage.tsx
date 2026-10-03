"use client";

import * as React from "react";
import { Lightning, SignOut, Trash, UserCircle } from "@phosphor-icons/react";
import { toast } from "sonner";

import { haptic } from "@/components/phone/lib/haptics";
import { useNav } from "@/components/phone/PhoneContext";
import { Tap } from "@/components/phone/ui/Tap";
import { usePublic } from "./PublicContext";

/**
 * Settings → Account in JARVIS Public: who is signed in, the plan, Aura, sign
 * out, and deleting the account (Play requires deletion inside the app).
 */
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
      <Tap className="pub-link pub-danger" disabled={deleting} onClick={remove} feel={false}>
        <Trash size={16} weight="bold" /> {deleting ? "Deleting…" : confirming ? "Tap again to delete for good" : "Delete account"}
      </Tap>
    </div>
  );
}
