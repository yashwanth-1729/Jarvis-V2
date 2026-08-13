import type { Config } from "tailwindcss";

/**
 * Tokens are declared as HSL triplets in globals.css and consumed here through
 * `hsl(var(--x) / <alpha-value>)`, so every colour supports Tailwind's opacity
 * modifier (`bg-surface-2/60`) without duplicating the palette.
 */
const config: Config = {
  darkMode: "class",
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          0: "hsl(var(--surface-0) / <alpha-value>)",
          1: "hsl(var(--surface-1) / <alpha-value>)",
          2: "hsl(var(--surface-2) / <alpha-value>)",
          3: "hsl(var(--surface-3) / <alpha-value>)",
          4: "hsl(var(--surface-4) / <alpha-value>)",
        },
        line: {
          DEFAULT: "hsl(var(--line) / <alpha-value>)",
          strong: "hsl(var(--line-strong) / <alpha-value>)",
        },
        ink: {
          DEFAULT: "hsl(var(--ink) / <alpha-value>)",
          muted: "hsl(var(--ink-muted) / <alpha-value>)",
          dim: "hsl(var(--ink-dim) / <alpha-value>)",
          faint: "hsl(var(--ink-faint) / <alpha-value>)",
        },
        ember: {
          DEFAULT: "hsl(var(--ember) / <alpha-value>)",
          ink: "hsl(var(--ember-ink) / <alpha-value>)",
          dim: "hsl(var(--ember-dim) / <alpha-value>)",
        },
        critical: {
          DEFAULT: "hsl(var(--critical) / <alpha-value>)",
          dim: "hsl(var(--critical-dim) / <alpha-value>)",
        },
        positive: {
          DEFAULT: "hsl(var(--positive) / <alpha-value>)",
          dim: "hsl(var(--positive-dim) / <alpha-value>)",
        },
      },
      borderRadius: {
        DEFAULT: "var(--radius-sm)",
        md: "var(--radius-sm)",
        lg: "var(--radius)",
      },
      fontFamily: {
        // Wired to next/font in app/layout.tsx — self-hosted, no FOIT.
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-grotesk)", "var(--font-inter)", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontSize: {
        // Dense-dashboard scale. UI chrome lives at 11–13px; 14px+ is reserved
        // for content the user reads rather than scans.
        "2xs": ["10px", { lineHeight: "14px", letterSpacing: "0.02em" }],
        xs: ["11px", { lineHeight: "16px" }],
        sm: ["12px", { lineHeight: "18px" }],
        base: ["13px", { lineHeight: "20px" }],
        md: ["14px", { lineHeight: "21px" }],
        lg: ["16px", { lineHeight: "24px" }],
        xl: ["20px", { lineHeight: "28px", letterSpacing: "-0.01em" }],
        "2xl": ["26px", { lineHeight: "32px", letterSpacing: "-0.02em" }],
      },
      spacing: {
        rail: "var(--rail-w)",
        console: "var(--console-w)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(3px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        breathe: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
        sweep: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(200%)" },
        },
      },
      animation: {
        // Enter 180ms / exit implied faster; micro-interactions stay 150–300ms.
        "fade-in": "fade-in 180ms cubic-bezier(0.22, 1, 0.36, 1)",
        "slide-up": "slide-up 240ms cubic-bezier(0.22, 1, 0.36, 1)",
        breathe: "breathe 1.8s ease-in-out infinite",
        sweep: "sweep 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
