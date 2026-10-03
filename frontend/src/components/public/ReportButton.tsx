"use client";

import * as React from "react";
import { Flag } from "@phosphor-icons/react";
import { toast } from "sonner";

import { reportReply, type ReportReason } from "@/lib/gateway";
import { haptic } from "@/components/phone/lib/haptics";
import { Sheet } from "@/components/phone/ui/Sheet";
import { Tap } from "@/components/phone/ui/Tap";
import { usePublicOptional } from "./PublicContext";

const REASONS: Array<{ id: ReportReason; label: string }> = [
  { id: "harmful", label: "Harmful or dangerous" },
  { id: "hateful", label: "Hateful or abusive" },
  { id: "sexual", label: "Sexual content" },
  { id: "wrong", label: "Badly wrong" },
  { id: "other", label: "Something else" },
];

/** Flag a JARVIS reply (JARVIS Public only; Play requires it for AI apps). */
export function ReportButton({ text }: { text: string }) {
  const pub = usePublicOptional();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  if (!pub) return null;

  const send = async (reason: ReportReason) => {
    if (!pub.session) {
      toast("Sign in to report a reply");
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      await reportReply(pub.session.accessToken, reason, text);
      haptic("success");
      toast.success("Reported. Thanks", { description: "A person will look at it." });
      setOpen(false);
    } catch {
      haptic("warning");
      toast.error("Couldn't send the report", { description: "Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Tap className="ph-msg-action" aria-label="Report this reply" feel="select" onClick={() => setOpen(true)}>
        <Flag size={16} weight="bold" />
      </Tap>
      <Sheet open={open} onClose={() => setOpen(false)} title="Report this reply" eyebrow="What's wrong with it?" tone="red">
        <div className="pub-report">
          {REASONS.map((reason) => (
            <Tap key={reason.id} className="pub-report-reason" onClick={() => void send(reason.id)} disabled={busy} feel="select">
              {reason.label}
            </Tap>
          ))}
        </div>
      </Sheet>
    </>
  );
}
