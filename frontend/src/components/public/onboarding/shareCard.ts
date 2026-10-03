/**
 * The character card as a picture, and getting it out of the app.
 *
 * Drawn straight onto a canvas (no DOM screenshot library): a 1080×1350
 * portrait that fits an Instagram post or a WhatsApp status. Sharing tries,
 * in order: the image through the Web Share API, the text through it, a PNG
 * download (browsers only; the Android WebView ignores downloads), and the
 * brag text on the clipboard. Every step is optional and none of them throw.
 */
import { isNativeShell } from "@/lib/api";

export interface CardData {
  name: string;
  title: string;
  vibe: string;
  vibeEmoji: string;
  goals: string[];
  interests: string[];
  stageLine: string;
  /** Three gradient stops. */
  colors: [string, string, string];
}

export type ShareOutcome = "shared" | "downloaded" | "copied" | "cancelled" | "failed";

const W = 1080;
const H = 1350;
const INK = "#0b0b0e";

function fontVar(root: Element | null, name: string, fallback: string): string {
  if (!root) return fallback;
  const value = getComputedStyle(root).getPropertyValue(name).trim();
  return value || fallback;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Shrink a line until it fits. */
function fit(ctx: CanvasRenderingContext2D, text: string, weight: string, family: string, start: number, min: number, width: number): number {
  let size = start;
  for (; size > min; size -= 4) {
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(text).width <= width) break;
  }
  ctx.font = `${weight} ${size}px ${family}`;
  return size;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** HOLO, happy, in flat shapes. */
function drawHolo(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  ctx.save();
  // Projector glow.
  ctx.fillStyle = "rgba(11,11,14,0.14)";
  ctx.beginPath();
  ctx.ellipse(cx, cy + s * 0.5, s * 0.3, s * 0.05, 0, 0, Math.PI * 2);
  ctx.fill();

  // Antenna.
  ctx.strokeStyle = "#22e3ff";
  ctx.lineWidth = s * 0.035;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx, cy - s * 0.34);
  ctx.lineTo(cx, cy - s * 0.5);
  ctx.stroke();
  ctx.shadowColor = "#d4ff3a";
  ctx.shadowBlur = s * 0.12;
  ctx.fillStyle = "#d4ff3a";
  ctx.beginPath();
  ctx.arc(cx, cy - s * 0.53, s * 0.06, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Ear pods.
  ctx.fillStyle = "#8f7cff";
  roundRect(ctx, cx - s * 0.52, cy - s * 0.12, s * 0.12, s * 0.26, s * 0.06);
  ctx.fill();
  roundRect(ctx, cx + s * 0.4, cy - s * 0.12, s * 0.12, s * 0.26, s * 0.06);
  ctx.fill();

  // Head with an iridescent rim.
  const rim = ctx.createLinearGradient(cx - s * 0.45, cy - s * 0.35, cx + s * 0.45, cy + s * 0.35);
  rim.addColorStop(0, "#22e3ff");
  rim.addColorStop(0.35, "#b69cff");
  rim.addColorStop(0.7, "#ff7ac6");
  rim.addColorStop(1, "#d4ff3a");
  ctx.shadowColor = "rgba(34,227,255,0.6)";
  ctx.shadowBlur = s * 0.18;
  ctx.fillStyle = rim;
  roundRect(ctx, cx - s * 0.43, cy - s * 0.35, s * 0.86, s * 0.7, s * 0.26);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Visor.
  ctx.fillStyle = "#050812";
  roundRect(ctx, cx - s * 0.37, cy - s * 0.29, s * 0.74, s * 0.58, s * 0.2);
  ctx.fill();

  // Happy eyes (^ ^), a smile and blush.
  ctx.strokeStyle = "#9ff2ff";
  ctx.shadowColor = "#9ff2ff";
  ctx.shadowBlur = s * 0.06;
  ctx.lineWidth = s * 0.05;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(cx + side * s * 0.15, cy - s * 0.02, s * 0.075, Math.PI * 1.08, Math.PI * 1.92);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(cx, cy + s * 0.07, s * 0.09, Math.PI * 0.15, Math.PI * 0.85);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(255,122,198,0.55)";
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + side * s * 0.25, cy + s * 0.08, s * 0.055, s * 0.03, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export async function renderCard(data: CardData, root: Element | null): Promise<Blob | null> {
  try {
    const head = fontVar(root, "--font-head", "system-ui, sans-serif");
    const body = fontVar(root, "--font-body", "system-ui, sans-serif");
    const tag = fontVar(root, "--font-tag", "ui-monospace, monospace");
    await document.fonts?.ready;

    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Loud gradient, two soft highlights, a thick ink frame.
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, data.colors[0]);
    bg.addColorStop(0.55, data.colors[1]);
    bg.addColorStop(1, data.colors[2]);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    for (const [x, y, r] of [[900, 120, 520], [120, 1250, 560]] as const) {
      const light = ctx.createRadialGradient(x, y, 0, x, y, r);
      light.addColorStop(0, "rgba(255,255,255,0.42)");
      light.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = light;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.lineWidth = 14;
    ctx.strokeStyle = INK;
    roundRect(ctx, 30, 30, W - 60, H - 60, 64);
    ctx.stroke();

    ctx.fillStyle = INK;
    ctx.textBaseline = "alphabetic";

    // Top tags.
    ctx.font = `400 34px ${tag}`;
    ctx.textAlign = "left";
    ctx.fillText("JARVIS PUBLIC", 92, 122);
    ctx.font = `400 30px ${tag}`;
    const lvl = "LVL 1";
    const lvlWidth = ctx.measureText(lvl).width + 44;
    roundRect(ctx, W - 92 - lvlWidth, 80, lvlWidth, 58, 29);
    ctx.fill();
    ctx.fillStyle = data.colors[0];
    ctx.textAlign = "center";
    ctx.fillText(lvl, W - 92 - lvlWidth / 2, 120);

    // HOLO.
    drawHolo(ctx, W / 2, 330, 300);

    // Title, name, vibe.
    ctx.fillStyle = INK;
    ctx.textAlign = "center";
    ctx.font = `400 34px ${tag}`;
    ctx.fillText(ellipsize(ctx, data.title.toUpperCase(), 900), W / 2, 590);
    fit(ctx, data.name, "800", head, 132, 60, 900);
    ctx.fillText(ellipsize(ctx, data.name, 900), W / 2, 718);

    ctx.font = `700 40px ${body}`;
    const vibe = `${data.vibeEmoji}  ${data.vibe}`;
    const vibeWidth = Math.min(900, ctx.measureText(vibe).width + 72);
    roundRect(ctx, W / 2 - vibeWidth / 2, 758, vibeWidth, 76, 38);
    ctx.fill();
    ctx.fillStyle = "#f6f5f0";
    ctx.fillText(vibe, W / 2, 810);

    // Goals.
    ctx.fillStyle = INK;
    ctx.textAlign = "left";
    ctx.font = `400 30px ${tag}`;
    ctx.fillText("MAIN QUESTS", 92, 912);
    ctx.font = `700 44px ${body}`;
    data.goals.slice(0, 3).forEach((goal, index) => {
      const y = 978 + index * 66;
      ctx.font = `400 30px ${tag}`;
      ctx.fillText(`0${index + 1}`, 92, y);
      ctx.font = `700 44px ${body}`;
      ctx.fillText(ellipsize(ctx, goal, 800), 160, y);
    });

    // Day 1 sticker and interests.
    ctx.save();
    ctx.translate(92 + 150, 1222);
    ctx.rotate(-0.07);
    ctx.fillStyle = INK;
    roundRect(ctx, -150, -52, 300, 104, 26);
    ctx.fill();
    ctx.fillStyle = "#d4ff3a";
    ctx.textAlign = "center";
    ctx.font = `800 46px ${head}`;
    ctx.fillText("🔥 DAY 1", 0, 16);
    ctx.restore();

    ctx.textAlign = "right";
    ctx.fillStyle = INK;
    ctx.font = `48px ${body}`;
    ctx.fillText(data.interests.slice(0, 5).join(" "), W - 92, 1214);
    ctx.font = `600 28px ${body}`;
    ctx.fillText(ellipsize(ctx, data.stageLine, 520), W - 92, 1262);

    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  } catch {
    return null;
  }
}

export async function shareCard(data: CardData, root: Element | null): Promise<ShareOutcome> {
  const text = `Meet my JARVIS 🤖 I'm ${data.name}, ${data.title}. Vibe: ${data.vibe}. Main quests: ${data.goals.join(", ")}. Day 1 starts now 🔥`;
  const nav = typeof navigator === "undefined" ? null : navigator;
  const blob = await renderCard(data, root);

  if (blob && nav?.share && nav.canShare) {
    try {
      const file = new File([blob], "my-jarvis.png", { type: "image/png" });
      if (nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], text, title: "My JARVIS" });
        return "shared";
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    }
  }
  if (nav?.share) {
    try {
      await nav.share({ text, title: "My JARVIS" });
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
      link.download = "my-jarvis.png";
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
