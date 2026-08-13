import * as React from "react";

import { cn } from "@/lib/utils";

/** Thin wrapper over a native scroll container with themed scrollbars. */
export const ScrollArea = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("scrollbar-thin overflow-y-auto overflow-x-hidden", className)}
    {...props}
  >
    {children}
  </div>
));
ScrollArea.displayName = "ScrollArea";
