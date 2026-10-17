/**
 * Weekly Wrapped (roadmap, 2026-10-17): the week's proof as a 1080×1920 story
 * card, black and crimson like Lock-in, made to be posted. Drawn straight
 * onto a canvas. Sharing tries the image through the Web Share API, then the
 * text, a download (browsers only) and the clipboard, like the onboarding's
 * character card.
 */
import { isNativeShell } from "@/lib/api";

export interface WrappedData {
  /** "WEEK OF 12 OCT". */
  weekLabel: string;
  /** Time locked in this week, in minutes. */
  minutes: number;
  /** Against this same point last week; null without last week. */
  delta: number | null;
  /** Share of the plan kept, 0-1, or null. */
  kept: number | null;
  done: number;
  skipped: number;
  streak: number;
  bestDay: { label: string; minutes: number } | null;
  top: { title: string; minutes: number } | null;
  verdict: string;
  /** Who it's for ("Yash"), or empty. */
  name: string;
}

export type WrappedOutcome = "shared" | "downloaded" | "copied" | "cancelled" | "failed";

const W = 1080;
const H = 1920;
const CRIMSON = "#ff1f3d";
const BLOOD = "#c8102e";
const TEXT = "#ffe8ea";

export function hoursText(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

function fontVar(root: Element | null, name: string, fallback: string): string {
  if (!root) return fallback;
  return getComputedStyle(root).getPropertyValue(name).trim() || fallback;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitText(ctx: CanvasRenderingContext2D, text: string, weight: string, family: string, start: number, min: number, width: number) {
  let size = start;
  for (; size > min; size -= 6) {
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(text).width <= width) break;
  }
  ctx.font = `${weight} ${size}px ${family}`;
}

export async function renderWrapped(data: WrappedData, root: Element | null): Promise<Blob | null> {
  try {
    if (document.fonts?.ready) await document.fonts.ready;
    const head = fontVar(root, "--font-head", "sans-serif");
    const tag = fontVar(root, "--font-tag", "monospace");
    const body = fontVar(root, "--font-body", "sans-serif");
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Black, with blood-red light and scanlines.
    ctx.fillStyle = "#050505";
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W * 0.5, H * 0.28, 40, W * 0.5, H * 0.28, W * 0.9);
    glow.addColorStop(0, "rgba(255, 31, 61, 0.42)");
    glow.addColorStop(1, "rgba(255, 31, 61, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    const low = ctx.createRadialGradient(W, H, 20, W, H, W);
    low.addColorStop(0, "rgba(122, 0, 16, 0.5)");
    low.addColorStop(1, "rgba(122, 0, 16, 0)");
    ctx.fillStyle = low;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255, 255, 255, 0.025)";
    for (let y = 0; y < H; y += 6) ctx.fillRect(0, y, W, 2);

    const pad = 90;
    ctx.textBaseline = "alphabetic";

    // Header.
    ctx.fillStyle = CRIMSON;
    ctx.font = `400 34px ${tag}`;
    ctx.fillText("JARVIS · WEEKLY WRAPPED", pad, 170);
    ctx.fillStyle = "rgba(255, 232, 234, 0.6)";
    ctx.font = `400 30px ${tag}`;
    ctx.fillText(data.weekLabel, pad, 222);

    // The number.
    ctx.fillStyle = TEXT;
    ctx.font = `700 46px ${body}`;
    ctx.fillText(data.name ? `${data.name} locked in` : "Locked in", pad, 470);
    ctx.save();
    ctx.shadowColor = "rgba(255, 31, 61, 0.85)";
    ctx.shadowBlur = 60;
    ctx.fillStyle = CRIMSON;
    fitText(ctx, hoursText(data.minutes), "900", head, 260, 140, W - pad * 2);
    ctx.fillText(hoursText(data.minutes), pad - 6, 720);
    ctx.restore();
    if (data.delta !== null) {
      const up = data.delta >= 0;
      const label = `${up ? "▲" : "▼"} ${hoursText(Math.abs(data.delta))} vs last week`;
      ctx.font = `800 42px ${head}`;
      const width = ctx.measureText(label).width + 60;
      roundRect(ctx, pad, 780, width, 84, 42);
      ctx.fillStyle = up ? "rgba(255, 31, 61, 0.22)" : "rgba(255, 255, 255, 0.08)";
      ctx.fill();
      ctx.fillStyle = up ? "#ff6b79" : "rgba(255, 232, 234, 0.75)";
      ctx.fillText(label, pad + 30, 836);
    }

    // The kept bar.
    const barY = 960;
    ctx.fillStyle = "rgba(255, 232, 234, 0.7)";
    ctx.font = `400 30px ${tag}`;
    ctx.fillText(data.kept === null ? "NOTHING DUE THIS WEEK" : `${Math.round(data.kept * 100)}% OF THE PLAN KEPT`, pad, barY);
    roundRect(ctx, pad, barY + 26, W - pad * 2, 30, 15);
    ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
    ctx.fill();
    if (data.kept) {
      roundRect(ctx, pad, barY + 26, Math.max(30, (W - pad * 2) * data.kept), 30, 15);
      const fill = ctx.createLinearGradient(pad, 0, W - pad, 0);
      fill.addColorStop(0, BLOOD);
      fill.addColorStop(1, CRIMSON);
      ctx.fillStyle = fill;
      ctx.fill();
    }

    // Four facts.
    const facts: Array<[string, string]> = [
      ["DONE", `${data.done}${data.skipped ? ` · ${data.skipped} skipped` : ""}`],
      ["STREAK", data.streak ? `${data.streak} day${data.streak === 1 ? "" : "s"}` : "—"],
      ["BEST DAY", data.bestDay ? `${data.bestDay.label} · ${hoursText(data.bestDay.minutes)}` : "—"],
      ["MOST TIME", data.top ? `${data.top.title}` : "—"],
    ];
    const boxW = (W - pad * 2 - 30) / 2;
    facts.forEach(([label, value], index) => {
      const x = pad + (index % 2) * (boxW + 30);
      const y = 1100 + Math.floor(index / 2) * 220;
      roundRect(ctx, x, y, boxW, 190, 36);
      ctx.fillStyle = "rgba(255, 31, 61, 0.08)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 31, 61, 0.3)";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = "#ff4d5e";
      ctx.font = `400 26px ${tag}`;
      ctx.fillText(label, x + 32, y + 62);
      ctx.fillStyle = TEXT;
      fitText(ctx, value, "800", head, 54, 30, boxW - 64);
      ctx.fillText(value, x + 32, y + 140);
    });

    // The verdict.
    ctx.fillStyle = TEXT;
    fitText(ctx, data.verdict, "800", head, 64, 36, W - pad * 2);
    ctx.fillText(data.verdict, pad, 1640);

    // Footer.
    ctx.fillStyle = "rgba(255, 232, 234, 0.55)";
    ctx.font = `400 28px ${tag}`;
    ctx.fillText("LOCK IN WITH JARVIS", pad, H - 120);
    ctx.fillStyle = CRIMSON;
    ctx.beginPath();
    ctx.arc(W - pad - 16, H - 130, 16, 0, Math.PI * 2);
    ctx.fill();

    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  } catch {
    return null;
  }
}

export function wrappedText(data: WrappedData): string {
  const kept = data.kept === null ? "" : ` ${Math.round(data.kept * 100)}% of my plan kept.`;
  return `My week on JARVIS: ${hoursText(data.minutes)} locked in.${kept} ${data.verdict} 🔒`;
}

export async function shareWrapped(blob: Blob | null, data: WrappedData): Promise<WrappedOutcome> {
  const text = wrappedText(data);
  const nav = typeof navigator === "undefined" ? null : navigator;
  if (blob && nav?.share && nav.canShare) {
    try {
      const file = new File([blob], "jarvis-wrapped.png", { type: "image/png" });
      if (nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], text, title: "My week, wrapped" });
        return "shared";
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    }
  }
  if (nav?.share) {
    try {
      await nav.share({ text, title: "My week, wrapped" });
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    }
  }
  if (blob && !isNativeShell()) {
    try {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "jarvis-wrapped.png";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      return "downloaded";
    } catch {
      // Fall through to the clipboard.
    }
  }
  try {
    await nav?.clipboard?.writeText(text);
    if (nav?.clipboard) return "copied";
  } catch {
    // Nothing left to try.
  }
  return "failed";
}
