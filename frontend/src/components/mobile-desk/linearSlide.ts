/** Shared linear progress for the page track and dock, without React frame updates. */
export const MS_PER_SPACE = 320;

export function createLinearSlide(targets: { element: HTMLElement; percent: number }[], initial: number) {
  let from = initial;
  let destination = initial;
  let duration = 0;
  let animations: Animation[] = [];
  const transform = (position: number, percent: number) => `translateX(${position * percent}%)`;
  const position = () => {
    const elapsed = Number(animations[0]?.currentTime ?? 0);
    return animations.length && duration > 0
      ? from + (destination - from) * Math.min(1, Math.max(0, elapsed / duration))
      : destination;
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
      duration = Math.abs(next - current) * MS_PER_SPACE;
      place(next);
      if (immediate || duration < 1) return;
      animations = targets.map(({ element, percent }) => element.animate([
        { transform: transform(current, percent) },
        { transform: transform(next, percent) },
      ], { duration, easing: "linear" }));
    },
    dispose() { cancel(); place(destination); },
  };
}
