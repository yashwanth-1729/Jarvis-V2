"use client";

import { Onboarding } from "./onboarding/Onboarding";
import { PlansScreen } from "./PlansScreen";
import { usePublic } from "./PublicContext";
import { SignInScreen } from "./SignInScreen";

/** Whatever comes before the app itself: onboarding, sign-in, then the soft paywall once. */
export function PublicStage() {
  const pub = usePublic();
  if (pub.stage === "onboarding") return <Onboarding onFinish={pub.completeOnboarding} />;
  if (pub.stage === "signin") return <SignInScreen />;
  if (pub.stage === "intro") return <PlansScreen mode="intro" onDone={pub.completeIntro} />;
  return null;
}
