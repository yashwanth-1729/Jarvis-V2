"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "outline" | "danger";
type Size = "xs" | "sm" | "md" | "icon" | "icon-sm";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-ember text-ember-ink hover:bg-ember/90 active:bg-ember/80 font-medium",
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

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Expands the pointer/touch hit box beyond the visual bounds without
   *  changing layout — keeps dense 24–28px controls reachable on touch. */
  expandHitArea?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant = "secondary", size = "md", expandHitArea, ...props },
    ref,
  ) => (
    <button
      ref={ref}
      className={cn(
        "relative inline-flex select-none items-center justify-center whitespace-nowrap rounded",
        "transition-colors duration-150 ease-out",
        "disabled:pointer-events-none disabled:opacity-40",
        "cursor-pointer",
        expandHitArea &&
          "before:absolute before:-inset-2 before:content-[''] before:rounded",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
