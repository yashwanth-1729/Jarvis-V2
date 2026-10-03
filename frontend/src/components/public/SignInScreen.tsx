"use client";

import * as React from "react";
import { ArrowRight, EnvelopeSimple, LockKey, Sparkle } from "@phosphor-icons/react";

import { AuthError, AUTH_CONFIGURED, sendEmailCode, verifyEmailCode } from "@/lib/publicAuth";
import { haptic } from "@/components/phone/lib/haptics";
import { emitFx } from "@/components/phone/fx/fxBus";
import { Tap } from "@/components/phone/ui/Tap";
import { usePublic } from "./PublicContext";

/**
 * Save your character: sign in with a 6-digit email code. Shown once, after
 * onboarding (the answers are already saved on the phone; this attaches them
 * to an account so plan, Aura and the trial follow the user).
 */
export function SignInScreen() {
  const pub = usePublic();
  const [email, setEmail] = React.useState("");
  const [code, setCode] = React.useState("");
  const [step, setStep] = React.useState<"email" | "code">("email");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const name = pub.profile?.callMe || pub.profile?.name || "you";

  const send = async () => {
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError("That email looks off.");
      haptic("warning");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await sendEmailCode(email);
      setStep("code");
      haptic("success");
    } catch (exc) {
      setError(exc instanceof AuthError ? exc.message : "Couldn't send the code.");
      haptic("warning");
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!/^\d{6}$/.test(code.trim())) {
      setError("The code is 6 digits.");
      haptic("warning");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await verifyEmailCode(email, code);
      haptic("success");
      emitFx("success", { x: 0.5, y: 0.4 });
      pub.completeSignIn(session);
    } catch (exc) {
      setError(exc instanceof AuthError ? exc.message : "Couldn't sign you in.");
      haptic("warning");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pub-screen pub-signin" aria-label="Sign in">
      <div className="pub-signin-hero">
        <span className="pub-eyebrow"><Sparkle size={14} weight="fill" /> Last step</span>
        <h1 className="pub-title">Save {name}&apos;s character.</h1>
        <p className="pub-sub">One code to your email and your plan, Aura and streaks follow you to any phone.</p>
      </div>

      {!AUTH_CONFIGURED ? (
        <div className="pub-card" data-tone="amber">
          <LockKey size={28} weight="fill" />
          <strong>Accounts open with the public launch.</strong>
          <p>Until then, use the planner on this phone. The AI side unlocks once you can sign in.</p>
        </div>
      ) : step === "email" ? (
        <div className="pub-form">
          <label className="pub-field">
            <EnvelopeSimple size={22} weight="bold" />
            <input
              className="pub-input"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@gmail.com"
              aria-label="Email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void send()}
            />
          </label>
          <Tap className="pub-cta" onClick={() => void send()} disabled={busy} feel={false} squish={0.94}>
            {busy ? "Sending…" : "Send my code"} <ArrowRight size={20} weight="bold" />
          </Tap>
        </div>
      ) : (
        <div className="pub-form">
          <p className="pub-sub">Code sent to <b>{email.trim()}</b>. Check spam too.</p>
          <input
            className="pub-input pub-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="••••••"
            aria-label="6-digit code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            onKeyDown={(event) => event.key === "Enter" && void verify()}
          />
          <Tap className="pub-cta" onClick={() => void verify()} disabled={busy} feel={false} squish={0.94}>
            {busy ? "Checking…" : "Let me in"} <ArrowRight size={20} weight="bold" />
          </Tap>
          <Tap className="pub-link" onClick={() => { setStep("email"); setCode(""); }} feel="select">
            Use a different email
          </Tap>
        </div>
      )}

      {error && <p className="pub-error" role="alert">{error}</p>}

      <Tap className="pub-link pub-skip" onClick={pub.continueOffline} feel="select">
        Not now. Just the planner
      </Tap>
    </section>
  );
}
