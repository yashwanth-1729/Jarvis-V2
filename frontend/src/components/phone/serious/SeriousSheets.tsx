"use client";

/**
 * Lock-in's sheets, mounted once for the whole phone app: "Fit it back in"
 * (catch-up) and the evening check-in. They open from anywhere through
 * `openCatchUp()` / `openCheckIn()` (catchUp.ts), which the check-in
 * notification and Today's card both use.
 */
import * as React from "react";

import { CatchUpSheet } from "./CatchUpSheet";
import { CheckInSheet } from "./CheckInSheet";
import { OPEN_CATCH_UP, OPEN_CHECK_IN, OPEN_WRAPPED } from "./catchUp";
import { WrappedSheet } from "./WrappedSheet";

export function SeriousSheets() {
  const [catchUp, setCatchUp] = React.useState(false);
  const [checkIn, setCheckIn] = React.useState<{ open: boolean; speak: boolean }>({ open: false, speak: false });
  const [wrapped, setWrapped] = React.useState(false);

  React.useEffect(() => {
    const onCatchUp = () => {
      setCheckIn((current) => ({ ...current, open: false }));
      setCatchUp(true);
    };
    const onCheckIn = (event: Event) => {
      const speak = Boolean((event as CustomEvent<{ speak?: boolean }>).detail?.speak);
      setCatchUp(false);
      setCheckIn({ open: true, speak });
    };
    const onWrapped = () => {
      setCatchUp(false);
      setCheckIn((current) => ({ ...current, open: false }));
      setWrapped(true);
    };
    window.addEventListener(OPEN_CATCH_UP, onCatchUp);
    window.addEventListener(OPEN_CHECK_IN, onCheckIn);
    window.addEventListener(OPEN_WRAPPED, onWrapped);
    return () => {
      window.removeEventListener(OPEN_CATCH_UP, onCatchUp);
      window.removeEventListener(OPEN_CHECK_IN, onCheckIn);
      window.removeEventListener(OPEN_WRAPPED, onWrapped);
    };
  }, []);

  return (
    <>
      <CatchUpSheet open={catchUp} onClose={() => setCatchUp(false)} />
      <CheckInSheet open={checkIn.open} speak={checkIn.speak} onClose={() => setCheckIn({ open: false, speak: false })} />
      <WrappedSheet open={wrapped} onClose={() => setWrapped(false)} />
    </>
  );
}
