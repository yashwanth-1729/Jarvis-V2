/**
 * Serious mode's particle bursts: real DOM sparks that fly out of the button
 * you pressed. "ignite" (Start) throws hot orange embers outward and flashes
 * the screen's edges; "forge" (Done) sprays gold upward. Pure CSS animation
 * on transform/opacity, so the compositor plays it; skipped for reduced
 * motion.
 */

type Burst = "ignite" | "forge";

const COLORS: Record<Burst, string[]> = {
  ignite: ["#FF4D1F", "#FF8A1F", "#FFB21F", "#FF2A12"],
  forge: ["#FFD34D", "#FFB21F", "#FFF1B8", "#FF8A1F"],
};

export function emberBurst(origin: Element | null, kind: Burst): void {
  if (typeof window === "undefined" || !origin) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const host = origin.closest(".ph") ?? document.body;
  const box = origin.getBoundingClientRect();
  const layer = document.createElement("div");
  layer.className = "ph-embers";
  layer.setAttribute("aria-hidden", "true");
  const count = kind === "ignite" ? 18 : 22;
  for (let i = 0; i < count; i += 1) {
    const spark = document.createElement("span");
    spark.className = "ph-ember";
    const angle = kind === "forge"
      ? -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9
      : Math.random() * Math.PI * 2;
    const distance = 40 + Math.random() * (kind === "forge" ? 120 : 90);
    const size = 4 + Math.random() * 6;
    spark.style.cssText = [
      `left:${box.left + box.width / 2}px`,
      `top:${box.top + box.height / 2}px`,
      `width:${size}px`,
      `height:${size}px`,
      `--dx:${Math.cos(angle) * distance}px`,
      `--dy:${Math.sin(angle) * distance + (kind === "ignite" ? -20 : 0)}px`,
      `--ember:${COLORS[kind][i % COLORS[kind].length]}`,
      `animation-duration:${600 + Math.random() * 500}ms`,
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
  window.setTimeout(() => layer.remove(), 1300);
}
