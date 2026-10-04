/**
 * Taps on a JARVIS notification's Start, Done or Check in button (Android).
 *
 * The button opens MainActivity, which keeps the tap (JarvisPendingAction in
 * JarvisNotifications.kt) and dispatches `jarvis-notification-action`; a tap
 * that launched the app cold waits until the page asks. Either way the page
 * collects it with `JarvisNotifications.takeAction()`, which also clears it,
 * so each tap reaches exactly one subscriber once.
 */
import type { NativeNotificationBridge } from "@/lib/nativeNotifications";

export type NotificationAction = {
  verb: "start" | "done" | "checkin";
  /** The serious item (`/api/focus` uid). Always set for start and done. */
  uid?: string;
  /** The local day the card was about, "YYYY-MM-DD": a block's occurrence key. */
  occurrence?: string;
};

/** Dispatched by MainActivity when the bridge attaches and on every warm tap. */
export const NOTIFICATION_ACTION_EVENT = "jarvis-notification-action";
const BRIDGE_READY_EVENT = "jarvis-native-notifications-ready";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The bridge's JSON as an action, or null for "" and anything malformed. */
export function parseNotificationAction(raw: unknown): NotificationAction | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { verb, uid, occurrence } = value as Record<string, unknown>;
  if (verb !== "start" && verb !== "done" && verb !== "checkin") return null;
  const action: NotificationAction = { verb };
  if (typeof uid === "string" && uid.trim()) action.uid = uid.trim();
  // Start and Done act on one serious item; without it there is nothing to do.
  if (verb !== "checkin" && !action.uid) return null;
  if (typeof occurrence === "string" && DAY.test(occurrence.trim())) action.occurrence = occurrence.trim();
  return action;
}

/**
 * Call `handler` for every notification action: one already waiting (checked
 * at once), and each later one. Returns the unsubscribe function. Only the
 * native shell has the bridge; elsewhere this never calls `handler`.
 */
export function subscribeNotificationActions(handler: (a: NotificationAction) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  let active = true;
  const pull = () => {
    if (!active) return;
    let raw: unknown;
    try {
      raw = (window.JarvisNotifications as NativeNotificationBridge | undefined)?.takeAction?.();
    } catch {
      return; // A bridge mid-teardown; the next event asks again.
    }
    const action = parseNotificationAction(raw);
    if (action) handler(action);
  };
  window.addEventListener(BRIDGE_READY_EVENT, pull);
  window.addEventListener(NOTIFICATION_ACTION_EVENT, pull);
  pull();
  return () => {
    active = false;
    window.removeEventListener(BRIDGE_READY_EVENT, pull);
    window.removeEventListener(NOTIFICATION_ACTION_EVENT, pull);
  };
}
