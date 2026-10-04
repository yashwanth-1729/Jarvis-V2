/**
 * Serious mode's moments, in Lock-in's black and red (2026-10-04, the owner:
 * "more serious... more aura... more animations... more black and red").
 *
 * - `emberBurst`: real DOM sparks that fly out of the button you pressed.
 *   "ignite" (Start) throws crimson sparks outward and flashes the screen's
 *   edges red; "forge" (Done) sprays white-hot and red upward.
 * - `lockinStamp`: the screen slams. A "LOCKED IN" (or "NO SKIP.") stamp
 *   crashes in over a black-red flash, red lines cut across, the whole app
 *   shakes once.
 *
 * Pure CSS animation on transform/opacity, so the compositor plays it. Reduced
 * motion gets no sparks and a plain fade instead of the slam.
 */

type Burst = "ignite" | "forge";

const COLORS: Record<Burst, string[]> = {
  ignite: ["#FF1F3D", "#C8102E", "#FF4D5E", "#FFE8EA"],
  forge: ["#FFFFFF", "#FFE8EA", "#FF1F3D", "#FF4D5E"],
};

function reduced(): boolean {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

export function emberBurst(origin: Element | null, kind: Burst): void {
  if (typeof window === "undefined" || !origin || reduced()) return;
  const host = origin.closest(".ph") ?? document.body;
  const box = origin.getBoundingClientRect();
  const layer = document.createElement("div");
  layer.className = "ph-embers";
  layer.setAttribute("aria-hidden", "true");
  const count = kind === "ignite" ? 22 : 24;
  for (let i = 0; i < count; i += 1) {
    const spark = document.createElement("span");
    spark.className = "ph-ember";
    const angle = kind === "forge"
      ? -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9
      : Math.random() * Math.PI * 2;
    const distance = 46 + Math.random() * (kind === "forge" ? 130 : 110);
    const size = 3 + Math.random() * 6;
    spark.style.cssText = [
      `left:${box.left + box.width / 2}px`,
      `top:${box.top + box.height / 2}px`,
      `width:${size}px`,
      `height:${size}px`,
      `--dx:${Math.cos(angle) * distance}px`,
      `--dy:${Math.sin(angle) * distance + (kind === "ignite" ? -20 : 0)}px`,
      `--ember:${COLORS[kind][i % COLORS[kind].length]}`,
      `animation-duration:${600 + Math.random() * 550}ms`,
      `animation-delay:${Math.random() * 60}ms`,
    ].join(";");
    layer.appendChild(spark);
  }
  if (kind === "ignite") {
    const flash = document.createElement("span");
    flash.className = "ph-ignite-flash";
    layer.appendChild(flash);
  }
  host.appendChild(layer);
  window.setTimeout(() => layer.remove(), 1400);
}

let stamping: number | null = null;

/**
 * The slam. `start` stamps "LOCKED IN" with the title under it; `done` stamps
 * "NO SKIP." One at a time: a second stamp replaces the first.
 */
export function lockinStamp(kind: "start" | "done", title?: string): void {
  if (typeof document === "undefined") return;
  const host = document.querySelector(".ph") ?? document.body;
  host.querySelector(".ph-stamp")?.remove();
  if (stamping !== null) window.clearTimeout(stamping);

  const layer = document.createElement("div");
  layer.className = "ph-stamp";
  layer.dataset.kind = kind;
  if (reduced()) layer.dataset.calm = "true";
  layer.setAttribute("aria-hidden", "true");
  layer.innerHTML = [
    '<span class="ph-stamp-flash"></span>',
    '<span class="ph-stamp-line" data-side="top"></span>',
    '<span class="ph-stamp-line" data-side="bottom"></span>',
    '<span class="ph-stamp-core">',
    `<b class="ph-stamp-word" data-text="${kind === "start" ? "LOCKED IN" : "NO SKIP."}">${kind === "start" ? "LOCKED IN" : "NO SKIP."}</b>`,
    '<small class="ph-stamp-sub"></small>',
    "</span>",
  ].join("");
  const sub = layer.querySelector(".ph-stamp-sub");
  if (sub) sub.textContent = title ? title.toUpperCase() : kind === "start" ? "NO EXCUSES" : "DONE. COUNTED.";
  host.appendChild(layer);

  if (!reduced() && kind === "start" && host instanceof HTMLElement) {
    host.classList.remove("ph-shake");
    // Restart the shake even if one is still finishing.
    void host.offsetWidth;
    host.classList.add("ph-shake");
    window.setTimeout(() => host.classList.remove("ph-shake"), 460);
  }
  stamping = window.setTimeout(() => {
    layer.remove();
    stamping = null;
  }, kind === "start" ? 1500 : 1250);
}
