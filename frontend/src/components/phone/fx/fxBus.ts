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
  | "tab";

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
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (event) => {
      pointerX = event.clientX / Math.max(1, window.innerWidth);
      pointerY = event.clientY / Math.max(1, window.innerHeight);
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
