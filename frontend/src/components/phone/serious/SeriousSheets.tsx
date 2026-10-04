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
import { OPEN_CATCH_UP, OPEN_CHECK_IN } from "./catchUp";

export function SeriousSheets() {
  const [catchUp, setCatchUp] = React.useState(false);
  const [checkIn, setCheckIn] = React.useState<{ open: boolean; speak: boolean }>({ open: false, speak: false });

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
    window.addEventListener(OPEN_CATCH_UP, onCatchUp);
    window.addEventListener(OPEN_CHECK_IN, onCheckIn);
    return () => {
      window.removeEventListener(OPEN_CATCH_UP, onCatchUp);
      window.removeEventListener(OPEN_CHECK_IN, onCheckIn);
    };
  }, []);

  return (
    <>
      <CatchUpSheet open={catchUp} onClose={() => setCatchUp(false)} />
      <CheckInSheet open={checkIn.open} speak={checkIn.speak} onClose={() => setCheckIn({ open: false, speak: false })} />
    </>
  );
}
