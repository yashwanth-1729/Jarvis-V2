/** Shared progress for the page track and dock, without React frame updates.
 *
 * Interruptible by design: a new `move` reads where the current animation
 * actually is and starts from there, so fast taps never snap.
 *
 * Timing follows the iOS feel rather than a constant speed: a decelerating
 * curve (fast start, long settle) and a duration that grows sub-linearly with
 * distance, so crossing two spaces is not twice the wait. The previous
 * `linear` easing at 320ms per space is what made navigation feel mechanical
 * and slow (640ms across two spaces).
 */
export const MS_PER_SPACE = 300;
/** Cupertino's standard "ease out" ramp: most of the travel happens early. */
export const SPACE_EASING = "cubic-bezier(.32,.72,0,1)";

export function createLinearSlide(
  targets: { element: HTMLElement; percent: number }[],
  initial: number,
  onActive?: (active: boolean) => void,
) {
  let from = initial;
  let destination = initial;
  let duration = 0;
  let animations: Animation[] = [];
  const transform = (position: number, percent: number) => `translateX(${position * percent}%)`;
  const position = () => {
    const elapsed = Number(animations[0]?.currentTime ?? 0);
    if (!animations.length || duration <= 0) return destination;
    // Progress must be read through the same curve the animation is drawing,
    // or an interrupted slide jumps backwards to where a linear clock says.
    const time = Math.min(1, Math.max(0, elapsed / duration));
    return from + (destination - from) * ease(time);
  };
  const cancel = () => { animations.forEach(animation => animation.cancel()); animations = []; };
  const place = (value: number) => targets.forEach(({ element, percent }) => {
    element.style.transform = transform(value, percent);
  });
  place(initial);
  return {
    move(next: number, immediate = false) {
      const current = position();
      cancel();
      from = current;
      destination = next;
      const spaces = Math.abs(next - current);
      // One space 300ms; each further space adds only 70ms (iOS keeps long
      // journeys from feeling long).
      duration = spaces <= 1 ? spaces * MS_PER_SPACE : MS_PER_SPACE + (spaces - 1) * 70;
      place(next);
      if (immediate || duration < 1) {
        onActive?.(false);
        return;
      }
      onActive?.(true);
      animations = targets.map(({ element, percent }) => element.animate([
        { transform: transform(current, percent) },
        { transform: transform(next, percent) },
      ], { duration, easing: SPACE_EASING }));
      animations[0]?.finished.then(() => onActive?.(false)).catch(() => undefined);
    },
    dispose() { cancel(); place(destination); onActive?.(false); },
  };
}

/** cubic-bezier(.32,.72,0,1) solved for y at time t, Newton then bisection. */
function ease(t: number): number {
  const bezier = (a: number, b: number, u: number) =>
    3 * a * u * (1 - u) * (1 - u) + 3 * b * u * u * (1 - u) + u * u * u;
  let low = 0;
  let high = 1;
  let guess = t;
  for (let i = 0; i < 12; i += 1) {
    const x = bezier(0.32, 0, guess);
    if (Math.abs(x - t) < 0.001) break;
    if (x < t) low = guess;
    else high = guess;
    guess = (low + high) / 2;
  }
  return bezier(0.72, 1, guess);
}
