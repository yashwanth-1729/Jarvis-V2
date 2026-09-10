"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "outline" | "danger";
type Size = "xs" | "sm" | "md" | "icon" | "icon-sm";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-ink hover:bg-accent/90 active:bg-accent/80 font-medium",
  secondary:
    "bg-surface-3 text-ink hover:bg-surface-4 active:bg-surface-4 border border-line",
  ghost: "text-ink-dim hover:bg-surface-3 hover:text-ink active:bg-surface-4",
  outline:
    "border border-line-strong bg-transparent text-ink-muted hover:bg-surface-3 hover:text-ink",
  danger:
    "bg-critical/15 text-critical border border-critical/30 hover:bg-critical/25",
};

const SIZES: Record<Size, string> = {
  xs: "h-6 gap-1 px-2 text-2xs",
  sm: "h-7 gap-1.5 px-2.5 text-xs",
  md: "h-8 gap-1.5 px-3 text-sm",
  icon: "h-8 w-8",
  "icon-sm": "h-6 w-6",
};

/**
 * How far each size reaches beyond its own edges to be tappable.
 *
 * The visual scale here is deliberately dense — 24 to 32px, which suits an
 * instrument panel and is far below the 44px a finger needs. The escape hatch
 * for that was `expandHitArea`, and it was opt-in, so almost nothing opted in:
 * measured on the device, every button in the app came back 24 to 32px tall,
 * including Send and Clear. A control that looks right and cannot be pressed
 * is not a compact control, it is a broken one.
 *
 * So expansion is on by default and sized per control, bringing each to about
 * 44px without moving a single pixel of layout.
 */
const HIT_AREA: Record<Size, string> = {
  xs: "before:-inset-x-2 before:-inset-y-[10px]",
  sm: "before:-inset-x-2 before:-inset-y-2",
  md: "before:-inset-x-1.5 before:-inset-y-1.5",
  icon: "before:-inset-1.5",
  "icon-sm": "before:-inset-2.5",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /**
   * Expands the touch box beyond the visual bounds without changing layout.
   *
   * On by default. Pass `false` only where neighbouring controls sit close
   * enough that the expanded boxes would overlap and steal each other's taps.
   */
  expandHitArea?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant = "secondary", size = "md", expandHitArea = true, ...props },
    ref,
  ) => (
    <button
      ref={ref}
      className={cn(
        "ui-button relative inline-flex select-none items-center justify-center whitespace-nowrap rounded",
        "transition-colors duration-150 ease-out",
        "disabled:pointer-events-none disabled:opacity-40",
        "cursor-pointer",
        expandHitArea && [
          "before:absolute before:content-[''] before:rounded",
          HIT_AREA[size],
        ],
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
