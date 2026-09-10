import { cn } from "@/lib/utils";

/** Shared identity for the workspace, assistant messages and navigation. */
export function BrandMark({ className }: { className?: string }) {
  return <span aria-hidden className={cn("brand-mark", className)}>
    <svg viewBox="0 0 32 32" fill="none">
      <path d="M16 3 27.25 9.5v13L16 29 4.75 22.5v-13L16 3Z" stroke="currentColor" strokeWidth="1.2" />
      <path d="M16 9v10.5a3.5 3.5 0 0 1-7 0M16 9h6M12 9h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="23" cy="22" r="1.5" fill="currentColor" />
    </svg>
  </span>;
}
