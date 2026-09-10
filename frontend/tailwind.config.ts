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
        accent: {
          DEFAULT: "hsl(var(--accent) / <alpha-value>)",
          ink: "hsl(var(--accent-ink) / <alpha-value>)",
          dim: "hsl(var(--accent-dim) / <alpha-value>)",
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
        sans: ["var(--font-inter, ui-sans-serif)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-grotesk, ui-sans-serif)", "var(--font-inter, ui-sans-serif)", "sans-serif"],
        mono: ["var(--font-mono, ui-monospace)", "ui-monospace", "SFMono-Regular", "monospace"],
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
        // Drives the HUD's dashed rings. Referenced from inline styles in
        // HudLayer, so it must exist as a global keyframe, not a utility.
        "hud-spin": {
          from: { transform: "rotate(0deg)" },
          to: { transform: "rotate(360deg)" },
        },
        // One word of a streaming reply arriving.
        //
        // A rise of two pixels and a touch of blur, not a slide: the word must
        // be readable the instant it is legible, so this is a materialisation
        // rather than a movement. Blur is affordable here only because each
        // element is a single word for 300ms and then never animates again.
        "word-in": {
          from: { opacity: "0", transform: "translateY(2px)", filter: "blur(3px)" },
          to: { opacity: "1", transform: "translateY(0)", filter: "blur(0)" },
        },
        // The deploy sequence: a dot, then a line, then a rectangle.
        //
        // Split across two elements on purpose. Scaling a bordered box scales
        // its border with it, so the hairline would arrive four times too
        // thick and thin out as it settled. Instead a separate beam does the
        // dot-to-line, and the panel itself only ever scales on Y — its border
        // is drawn at final size the whole time.
        //
        // `scaleX` from 0 with a fixed 2px height is the dot: zero width, so
        // nothing is visible until it starts growing, which is what "a point
        // with no dimensions" looks like on a screen made of pixels.
        "deploy-beam": {
          "0%": { transform: "scaleX(0)", opacity: "0" },
          "8%": { transform: "scaleX(0.008)", opacity: "1" },
          // Held: this is the dot, and it has to sit there long enough to be
          // seen as a point before it becomes a line.
          "22%": { transform: "scaleX(0.008)", opacity: "1" },
          "78%": { transform: "scaleX(1)", opacity: "1" },
          "100%": { transform: "scaleX(1)", opacity: "0" },
        },
        // The rectangle growing out of the line. Length is already correct, so
        // only breadth changes — exactly as a HUD element unfolds.
        "deploy-panel": {
          "0%": { transform: "scaleY(0)" },
          "100%": { transform: "scaleY(1)" },
        },
        // The readout, arriving once there is something to arrive into.
        "deploy-readout": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        // Panel content arriving inside a frame that is already on screen.
        // Small travel on purpose: the container is not moving, so a large
        // slide would read as a different panel rather than new contents.
        "surface-in": {
          from: { opacity: "0", transform: "translateY(18px) scale(0.97)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "surface-out": {
          from: { opacity: "1", transform: "translateY(0) scale(1)" },
          to: { opacity: "0", transform: "translateY(-6px) scale(0.99)" },
        },
        "row-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "row-out": {
          from: { opacity: "1", transform: "translateX(0)" },
          to: { opacity: "0", transform: "translateX(8px)" },
        },
        // A row being destroyed. Transform and opacity only — `filter` would
        // be the obvious way to do heat and is far too expensive per frame on
        // a phone, so the glow is a separate swept element instead.
        burn: {
          "0%": { opacity: "1", transform: "translateX(0) scaleY(1)" },
          "45%": { opacity: "0.85", transform: "translateX(2px) scaleY(1)" },
          "100%": { opacity: "0", transform: "translateX(-10px) scaleY(0.92)" },
        },
        // The heat itself: a gradient bar swept across the row.
        "ember-sweep": {
          from: { transform: "translateX(-110%)" },
          to: { transform: "translateX(220%)" },
        },
        // A number that changed, so a count cannot slip past unnoticed.
        "count-pop": {
          "0%": { transform: "scale(1)" },
          "40%": { transform: "scale(1.12)" },
          "100%": { transform: "scale(1)" },
        },
        // The HUD listbox opening. Scales from the top edge so it reads as
        // unfolding out of its trigger rather than appearing over it.
        "hud-drop": {
          from: { opacity: "0", transform: "translateY(-4px) scaleY(0.96)" },
          to: { opacity: "1", transform: "translateY(0) scaleY(1)" },
        },
      },
      animation: {
        // Enter 180ms / exit implied faster; micro-interactions stay 150–300ms.
        "fade-in": "fade-in 180ms cubic-bezier(0.22, 1, 0.36, 1)",
        "slide-up": "slide-up 240ms cubic-bezier(0.22, 1, 0.36, 1)",
        breathe: "breathe 1.8s ease-in-out infinite",
        sweep: "sweep 1.6s ease-in-out infinite",
        "hud-spin": "hud-spin 34s linear infinite",
        "hud-drop": "hud-drop 160ms cubic-bezier(0.22, 1, 0.36, 1)",
        // Sequenced by delay, so the whole thing reads as one motion:
        //   0-420ms   the core moves aside (VoiceMode)
        //   420-900ms dot -> line
        //   760ms+    line -> rectangle
        //   980ms+    numbers
        // Slower than felt necessary on paper, and it needed to be. At ~1.2s
        // end to end the sequence was correct and unreadable — each stage was
        // over before the eye had resolved it, so the whole thing registered
        // as "a box appeared". The stages have to be long enough to be seen
        // as stages.
        "deploy-beam": "deploy-beam 760ms cubic-bezier(0.33, 1, 0.68, 1) 460ms both",
        "deploy-panel": "deploy-panel 620ms cubic-bezier(0.33, 1, 0.68, 1) 1040ms both",
        "deploy-readout": "deploy-readout 420ms cubic-bezier(0.33, 1, 0.68, 1) 1520ms both",
        "word-in": "word-in 300ms cubic-bezier(0.33, 1, 0.68, 1) both",
        "surface-in": "surface-in 520ms cubic-bezier(0.33, 1, 0.68, 1) both",
        "surface-out": "surface-out 340ms cubic-bezier(0.33, 0, 0.67, 1) both",
        "row-in": "row-in 420ms cubic-bezier(0.33, 1, 0.68, 1) both",
        "row-out": "row-out 170ms cubic-bezier(0.4, 0, 1, 1) both",
        burn: "burn 420ms cubic-bezier(0.4, 0, 1, 1) both",
        "ember-sweep": "ember-sweep 420ms cubic-bezier(0.4, 0, 0.2, 1) both",
        "count-pop": "count-pop 320ms cubic-bezier(0.22, 1, 0.36, 1)",
      },
    },
  },
  plugins: [],
};

export default config;
