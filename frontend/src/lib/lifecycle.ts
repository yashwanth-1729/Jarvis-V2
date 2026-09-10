/**
 * Foreground-only lifecycle.
 *
 * JARVIS on the phone is an app you open, use, and close. Nothing survives it:
 * no background sync, no wake lock, no service worker keeping a socket alive.
 * That is a deliberate product decision, and it only holds if every subsystem
 * that acquires something expensive — a WebSocket, a microphone, a timer —
 * hands back a way to release it.
 *
 * This is that register. Callers add a teardown; the shutdown signals below
 * run them all exactly once.
 *
 * On which signal actually fires: `beforeunload` is the familiar one and the
 * wrong one. Mobile browsers and webviews routinely kill a backgrounded app
 * without ever dispatching it, so cleanup hung off `beforeunload` simply does
 * not run on the platform that most needs it. `pagehide` and a `hidden`
 * `visibilitychange` are the pair that do fire, so both are wired here.
 */

type Teardown = () => void;

const registry = new Set<Teardown>();
let wired = false;

/** Run every registered teardown, then forget them.
 *
 *  Safe to call repeatedly: the registry is drained first, so a teardown that
 *  itself triggers a shutdown cannot recurse. */
export function shutdown(): void {
  const pending = [...registry];
  registry.clear();
  for (const teardown of pending) {
    try {
      teardown();
    } catch {
      // One subsystem failing to clean up must not prevent the others from
      // trying — a leaked timer is better than a live microphone.
    }
  }
}

/**
 * Things to do when the app goes away — as opposed to things to release.
 *
 * Deliberately a second, separate registry. `shutdown()` drains its own set so
 * a teardown can only ever run once, which is exactly right for releasing a
 * microphone and exactly wrong for publishing changes: leaving the app and
 * coming back must be able to publish again. These handlers persist.
 */
const onHiddenHandlers = new Set<Teardown>();

function fireHidden(): void {
  for (const handler of [...onHiddenHandlers]) {
    try {
      handler();
    } catch {
      // Same reasoning as shutdown: one failure must not block the rest.
    }
  }
}

/**
 * Run something each time the app is hidden or closed.
 *
 * The work itself may not finish — a backgrounded webview can be killed at any
 * moment — so callers must be safe to interrupt. For sync that is already true:
 * the pending queue lives in IndexedDB, so an interrupted publish simply
 * happens on the next one.
 */
export function onHidden(handler: Teardown): () => void {
  wire();
  onHiddenHandlers.add(handler);
  return () => {
    onHiddenHandlers.delete(handler);
  };
}

function wire(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;

  window.addEventListener("pagehide", () => {
    fireHidden();
    shutdown();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    // Publish before releasing: `shutdown()` stops the things a sync might
    // need, so the order matters even though the sync itself is async.
    fireHidden();
    shutdown();
  });
}

/**
 * Register something to release when the app goes away.
 *
 * Returns an unregister function, so a React effect can hand back exactly one
 * cleanup that works for both cases: the component unmounting on its own, and
 * the whole app being closed.
 */
export function onShutdown(teardown: Teardown): () => void {
  wire();
  registry.add(teardown);
  return () => {
    registry.delete(teardown);
  };
}
