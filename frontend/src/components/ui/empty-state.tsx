import * as React from "react";

import { cn } from "@/lib/utils";

export function EmptyState({
  icon,
  title,
  hint,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line px-6 py-14 text-center",
        className,
      )}
    >
      {icon && (
        <div className="flex h-9 w-9 items-center justify-center rounded border border-line bg-surface-2 text-ink-faint">
          {icon}
        </div>
      )}
      <p className="font-display text-md font-medium text-ink-muted">{title}</p>
      {hint && (
        <p className="max-w-[34ch] text-sm leading-relaxed text-ink-faint">{hint}</p>
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded bg-surface-2",
        "after:absolute after:inset-0 after:animate-sweep after:bg-gradient-to-r",
        "after:from-transparent after:via-surface-4/60 after:to-transparent after:content-['']",
        className,
      )}
    />
  );
}
