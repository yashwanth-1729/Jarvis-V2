import type { CreateTypes } from "canvas-confetti";

/**
 * A small celebratory burst from a point on screen (a task being finished).
 *
 * The library is loaded on first use, so it costs nothing until something is
 * actually completed. Skipped entirely under reduced motion.
 */

const COLORS = ["#D4FF3A", "#FF7AC6", "#7CC7FF", "#FFB23D", "#B69CFF"];
let instance: Promise<CreateTypes> | null = null;

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

async function burster(): Promise<CreateTypes> {
  if (!instance) {
    instance = import("canvas-confetti").then(({ default: confetti }) => {
      const canvas = document.createElement("canvas");
      canvas.className = "ph-confetti";
      canvas.setAttribute("aria-hidden", "true");
      document.body.appendChild(canvas);
      return confetti.create(canvas, { resize: true, useWorker: true });
    });
  }
  return instance;
}

export function burst(x: number, y: number, power = 1): void {
  if (typeof window === "undefined" || reducedMotion()) return;
  const origin = { x: x / window.innerWidth, y: y / window.innerHeight };
  void burster().then((fire) => {
    void fire({
      particleCount: Math.round(26 * power),
      spread: 70,
      startVelocity: 26 * power,
      decay: 0.9,
      gravity: 1.1,
      scalar: 0.8,
      ticks: 120,
      origin,
      colors: COLORS,
      shapes: ["circle", "square"],
      disableForReducedMotion: true,
    });
  });
}

/** Burst from the centre of an element. */
export function burstFrom(element: Element | null, power = 1): void {
  if (!element) return;
  const box = element.getBoundingClientRect();
  burst(box.left + box.width / 2, box.top + box.height / 2, power);
}
