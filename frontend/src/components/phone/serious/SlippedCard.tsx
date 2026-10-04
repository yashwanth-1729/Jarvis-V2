"use client";

/**
 * Today's "it slipped" card: when a Lock-in block's time passed this week with
 * no Done, the week doesn't die. One tap asks JARVIS to fit it back in; the
 * other lets it go (the stats still count the skip).
 */
import * as React from "react";
import { ArrowBendUpRight, Wind } from "@phosphor-icons/react";
import { toast } from "sonner";

import { usePublicOptional } from "@/components/public/PublicContext";
import { resetFocus } from "@/lib/focus";
import { haptic } from "../lib/haptics";
import { Tap } from "../ui/Tap";
import { letGo, missedLabel, openCatchUp } from "./catchUp";
import { Pulse } from "./Pulse";
import { useSerious } from "./SeriousContext";

export function SlippedCard() {
  const serious = useSerious();
  const pub = usePublicOptional();
  const [busy, setBusy] = React.useState(false);
  const missed = serious?.missed ?? [];
  if (!missed.length || (pub && !pub.has("lockin"))) return null;

  const first = missed[0];
  const title = missed.length === 1 ? `${missedLabel(first)} slipped.` : `${missed.length} Lock-ins slipped this week.`;

  const release = async () => {
    setBusy(true);
    try {
      await letGo(missed);
      serious?.reload();
      haptic("select");
      toast("Let go. Clean slate.", {
        description: "The stats still count it. Next one's yours.",
        action: {
          label: "Undo",
          onClick: () => {
            void Promise.all(missed.map((miss) => resetFocus(miss.uid, miss.occurrence))).then(() => serious?.reload());
          },
        },
      });
    } catch {
      toast.error("Couldn't do that", { description: "Try again in a moment." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ph-slipped ph-slide-in" aria-label="Lock-ins that slipped">
      <Pulse className="ph-slipped-pulse" live={false} />
      <span className="ph-slipped-top"><ArrowBendUpRight size={13} weight="bold" /> Plans bend</span>
      <h3>{title}</h3>
      <p>Don&apos;t let one miss kill the week. JARVIS will find time for it in the days left.</p>
      <div className="ph-slipped-actions">
        <Tap className="ph-btn ph-btn-ember" onClick={openCatchUp} disabled={busy} feel="heavy" squish={0.96}>
          <ArrowBendUpRight size={17} weight="bold" /> Fit it back in
        </Tap>
        <Tap className="ph-btn ph-slipped-go" onClick={() => void release()} disabled={busy} feel="select">
          <Wind size={17} weight="bold" /> Let go
        </Tap>
      </div>
    </section>
  );
}
