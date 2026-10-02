/**
 * The live background's input: things that happen in the app.
 *
 * Components never talk to the renderer directly. They emit an event kind
 * (a tap, a finished task, a delete, a tab switch...) and the background
 * decides how big a reaction that deserves. Continuous states (a reply
 * streaming in, a sync running) are "activity" levels instead of events.
 */

export type FxKind =
  | "tap"
  | "select"
  | "success"
  | "warning"
  | "heavy"
  | "toggle-on"
  | "toggle-off"
  | "gesture"
  | "open"
  | "close"
  | "tab"
  | "touch";

export type FxScene = "today" | "tasks" | "plan" | "memory";

export interface FxEvent {
  kind: FxKind;
  /** Screen position, 0-1 from the left and from the top. */
  x: number;
  y: number;
  /** For "tab": which way the new tab sits (-1 left, 1 right). */
  direction?: number;
}

type Listener = (event: FxEvent) => void;

const listeners = new Set<Listener>();
const activity = new Map<string, number>();
let scene: FxScene = "today";
const sceneListeners = new Set<(scene: FxScene) => void>();

// Where the last touch landed, so a reaction starts under the finger.
let pointerX = 0.5;
let pointerY = 0.6;

/**
 * Touch and scroll, read by the background on every frame it draws.
 *
 * Plain numbers rather than events: a finger dragging or a page flinging
 * writes a few fields here and nothing else, so it never costs a React
 * render or a shader call on the touch path (the user asked, 2026-10-02,
 * for the background to answer touching and scrolling, not just taps).
 */
export interface FxInput {
  /** Last finger (or mouse) position, 0-1 from the left and from the top. */
  x: number;
  y: number;
  /** A finger or a mouse button is on the screen. */
  down: boolean;
  /** A mouse is over the window with no button held (desktop). */
  hover: boolean;
  /** Recent travel of the finger, 0-1; the renderer lets it fade. */
  moved: number;
  /** Total vertical scroll so far, in screen heights. */
  scroll: number;
  /** Speed of the latest scroll step, screen heights per second; fades. */
  scrollSpeed: number;
}

const input: FxInput = { x: 0.5, y: 0.6, down: false, hover: false, moved: 0, scroll: 0, scrollSpeed: 0 };
let scrollAt = 0;
const scrollTops = new WeakMap<object, number>();

export function fxInput(): FxInput {
  return input;
}

// Pressables answer with their own reaction (haptic -> fx); a finger landing
// anywhere else gets a soft one under it.
const PRESSABLE = "button, a, input, textarea, select, label, [role='button'], [role='switch'], [role='slider'], [role='tab']";

if (typeof window !== "undefined") {
  const place = (event: PointerEvent) => {
    input.x = event.clientX / Math.max(1, window.innerWidth);
    input.y = event.clientY / Math.max(1, window.innerHeight);
  };
  window.addEventListener(
    "pointerdown",
    (event) => {
      place(event);
      pointerX = input.x;
      pointerY = input.y;
      input.down = true;
      const target = event.target as Element | null;
      if (!target?.closest?.(PRESSABLE)) emitFx("touch", { x: input.x, y: input.y });
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    "pointermove",
    (event) => {
      const fromX = input.x;
      const fromY = input.y;
      place(event);
      input.hover = event.pointerType === "mouse" && event.buttons === 0;
      if (input.down || input.hover) input.moved = Math.min(1, input.moved + Math.hypot(input.x - fromX, input.y - fromY) * 6);
    },
    { capture: true, passive: true },
  );
  const lift = () => {
    input.down = false;
  };
  window.addEventListener("pointerup", lift, { capture: true, passive: true });
  window.addEventListener("pointercancel", lift, { capture: true, passive: true });
  // Scroll events do not bubble, but a capturing window listener sees every
  // scroller's. Only vertical travel counts.
  window.addEventListener(
    "scroll",
    (event) => {
      const element = (event.target === document ? document.scrollingElement : event.target) as Element | null;
      if (!element || typeof element.scrollTop !== "number") return;
      const top = element.scrollTop;
      const previous = scrollTops.get(element) ?? top;
      scrollTops.set(element, top);
      const delta = (top - previous) / Math.max(1, window.innerHeight);
      if (!delta) return;
      const now = performance.now();
      const seconds = Math.max(8, now - scrollAt) / 1000;
      scrollAt = now;
      input.scroll += delta;
      input.scrollSpeed = Math.min(6, Math.abs(delta) / seconds);
    },
    { capture: true, passive: true },
  );
}

export function emitFx(kind: FxKind, at?: { x: number; y: number } | Element | null, direction?: number): void {
  let x = pointerX;
  let y = pointerY;
  if (at && typeof (at as Element).getBoundingClientRect === "function") {
    const box = (at as Element).getBoundingClientRect();
    x = (box.left + box.width / 2) / Math.max(1, window.innerWidth);
    y = (box.top + box.height / 2) / Math.max(1, window.innerHeight);
  } else if (at && "x" in at) {
    x = at.x;
    y = at.y;
  }
  const event: FxEvent = { kind, x, y, direction };
  for (const listener of listeners) listener(event);
}

export function onFx(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A continuous level (0-1) under a name; the strongest one wins. */
export function setFxActivity(name: string, level: number): void {
  if (level <= 0) activity.delete(name);
  else activity.set(name, Math.min(1, level));
}

export function fxActivity(): number {
  let strongest = 0;
  for (const level of activity.values()) strongest = Math.max(strongest, level);
  return strongest;
}

export function setFxScene(next: FxScene): void {
  if (next === scene) return;
  scene = next;
  for (const listener of sceneListeners) listener(next);
}

export function fxScene(): FxScene {
  return scene;
}

export function onFxScene(listener: (scene: FxScene) => void): () => void {
  sceneListeners.add(listener);
  return () => sceneListeners.delete(listener);
}
