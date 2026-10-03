"use client";

import { Lightning, UserCircle } from "@phosphor-icons/react";

import { useNav } from "@/components/phone/PhoneContext";
import { Tap } from "@/components/phone/ui/Tap";
import { usePublicOptional } from "./PublicContext";

/** Aura left, in the Today top bar of the public app; opens the plans. */
export function AuraChip() {
  const pub = usePublicOptional();
  const { push } = useNav();
  if (!pub) return null;
  if (!pub.session) {
    return (
      <Tap className="pub-chip" data-state="signin" onClick={pub.requestSignIn} feel="select" aria-label="Sign in">
        <UserCircle size={16} weight="bold" /> Sign in
      </Tap>
    );
  }
  const aura = pub.me ? Math.floor(pub.me.aura.balance) : null;
  return (
    <Tap className="pub-chip" data-low={aura !== null && aura < 5 ? true : undefined} onClick={() => push({ kind: "plans" })} feel="select" aria-label={`${aura ?? "?"} Aura left. See plans`}>
      <Lightning size={16} weight="fill" /> {aura ?? "…"}
    </Tap>
  );
}
