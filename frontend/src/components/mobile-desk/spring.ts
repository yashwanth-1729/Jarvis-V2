/** A spring, not a curve: the whole point of "native feel" motion.
 *
 * A CSS duration+easing always takes the same time and always starts from
 * rest, so an interrupted or flicked movement looks wrong no matter how good
 * the curve is. A spring carries **velocity**: throw a page with your finger
 * and it keeps that speed, then settles; grab it mid-flight and it continues
 * from exactly where and how fast it was.
 *
 * Integrated at a fixed 1/120s step (decoupled from the display's frame rate,
 * so a dropped frame changes nothing) and read back once per animation frame.
 * Everything it drives must be a transform or an opacity.
 */

export interface SpringOptions {
  /** How hard it pulls to the target. Higher = snappier. */
  stiffness?: number;
  /** How strongly it resists. Near-critical damping = no visible wobble. */
  damping?: number;
  mass?: number;
  /** Settled when both distance and speed are under these. */
  restDistance?: number;
  restSpeed?: number;
}

/** iOS-like page travel: quick, with a whisper of overshoot at the end. */
export const PAGE_SPRING: SpringOptions = { stiffness: 320, damping: 34, mass: 1 };
/** Small UI (dock pill, press): tighter and fully settled, no bounce. */
export const SNAP_SPRING: SpringOptions = { stiffness: 480, damping: 40, mass: 1 };

const STEP = 1 / 120;

export function createSpring(
  initial: number,
  onFrame: (value: number, velocity: number) => void,
  options: SpringOptions = PAGE_SPRING,
) {
  const { stiffness = 320, damping = 34, mass = 1, restDistance = 0.0005, restSpeed = 0.02 } =
    options;
  let value = initial;
  let velocity = 0;
  let target = initial;
  let frame = 0;
  let previous = 0;
  let carry = 0;
  let onSettle: (() => void) | null = null;

  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    // Clamped so a backgrounded tab does not integrate a huge catch-up step.
    carry += Math.min(0.064, (now - previous) / 1000);
    previous = now;
    while (carry >= STEP) {
      const force = -stiffness * (value - target) - damping * velocity;
      velocity += (force / mass) * STEP;
      value += velocity * STEP;
      carry -= STEP;
    }
    if (Math.abs(value - target) < restDistance && Math.abs(velocity) < restSpeed) {
      value = target;
      velocity = 0;
      stop();
      onFrame(value, 0);
      const settled = onSettle;
      onSettle = null;
      settled?.();
      return;
    }
    onFrame(value, velocity);
  };

  const start = () => {
    if (frame) return;
    previous = performance.now();
    carry = 0;
    frame = requestAnimationFrame(tick);
  };
  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  return {
    /** Spring towards `next`, keeping whatever velocity is already in flight. */
    to(next: number, settled?: () => void) {
      target = next;
      onSettle = settled ?? null;
      if (Math.abs(value - target) < restDistance && Math.abs(velocity) < restSpeed) {
        value = target;
        velocity = 0;
        onFrame(value, 0);
        settled?.();
        return;
      }
      start();
    },
    /** Hand the spring the finger's speed at release (units per second). */
    throwTo(next: number, initialVelocity: number, settled?: () => void) {
      velocity = initialVelocity;
      this.to(next, settled);
    },
    /** Drag: the finger owns the value, and its speed becomes the spring's. */
    set(next: number, trackedVelocity = 0) {
      stop();
      value = next;
      velocity = trackedVelocity;
      target = next;
      onFrame(value, velocity);
    },
    jump(next: number) {
      stop();
      value = target = next;
      velocity = 0;
      onFrame(value, 0);
    },
    get value() { return value; },
    get velocity() { return velocity; },
    get target() { return target; },
    get moving() { return frame !== 0; },
    dispose() { stop(); onSettle = null; },
  };
}

/** iOS rubber-band: pull past the edge and resistance grows with distance. */
export function rubberBand(overshoot: number, dimension: number, factor = 0.55): number {
  if (dimension <= 0) return 0;
  return (1 - 1 / (Math.abs(overshoot) * factor / dimension + 1)) * dimension * Math.sign(overshoot);
}
