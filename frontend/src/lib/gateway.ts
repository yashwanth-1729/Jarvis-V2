/**
 * The HOLO gateway's account API (gateway/README.md): plan, Aura, unlocked
 * features and the Lock-in trial. Model calls never come from here; the
 * on-device backend sends those through the gateway itself.
 */
import { HOLO_GATEWAY_URL } from "@/lib/publicAuth";

export type Feature = "chat" | "voice_en" | "lockin" | "voice_te" | "news" | "autonomy" | "early_access";

export interface Me {
  user_id: string;
  plan: { id: string; name: string; price_inr: number; monthly_aura: number; expires_at: string | null };
  aura: { balance: number; plan: number; topup: number; held: number };
  features: Record<Feature, boolean>;
  period: { start: string; end: string };
  trial: { lockin: { available: boolean; active: boolean; started_at: string | null; ends_at: string | null } };
  limits: { requests_per_minute: number; daily_cap_aura: number; spent_today_aura: number };
}

export class GatewayError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

async function call<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  if (!HOLO_GATEWAY_URL) throw new GatewayError("The JARVIS Public service isn't connected in this build.", 0, "not_configured");
  let response: Response;
  try {
    response = await fetch(`${HOLO_GATEWAY_URL}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
  } catch {
    throw new GatewayError("Can't reach the JARVIS Public service.", 0, "unreachable");
  }
  const data = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: string } } & T;
  if (!response.ok) {
    throw new GatewayError(data.error?.message ?? `Request failed (${response.status}).`, response.status, data.error?.code ?? "");
  }
  return data;
}

export function fetchMe(token: string): Promise<Me> {
  return call<Me>("/v1/me", token);
}

export function startLockinTrial(token: string): Promise<Me> {
  return call<Me>("/v1/trial/lockin", token, { method: "POST", body: "{}" });
}

export type ReportReason = "harmful" | "hateful" | "sexual" | "wrong" | "other";

/** "Report this reply" (Google Play's rule for generative-AI apps). */
export function reportReply(token: string, reason: ReportReason, excerpt: string, note?: string): Promise<{ ok: boolean }> {
  return call<{ ok: boolean }>("/v1/report", token, { method: "POST", body: JSON.stringify({ reason, excerpt, note }) });
}

/** Delete the account (gateway rows, and the login when the server can). */
export async function deleteAccount(token: string): Promise<void> {
  if (!HOLO_GATEWAY_URL) throw new GatewayError("The JARVIS Public service isn't connected in this build.", 0, "not_configured");
  const response = await fetch(`${HOLO_GATEWAY_URL}/v1/me`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new GatewayError(`Couldn't delete the account (${response.status}).`, response.status, "");
}

/** The plans as users see them (docs/public-edition.md). */
export const PLANS = [
  { id: "spawn", name: "Spawn", price: 0, aura: 50, tone: "soft", tagline: "Start here. Tasks, plans, reminders and chat.", adds: ["Every task and planning feature", "Text chat with JARVIS", "50 Aura a month"] },
  { id: "side_quest", name: "Side Quest", price: 99, aura: 250, tone: "lime", tagline: "Talk to it. Lock in.", adds: ["English voice", "Lock-in serious mode + stats", "250 Aura a month"] },
  { id: "main_character", name: "Main Character", price: 299, aura: 750, tone: "pink", tagline: "Your language. Your news.", adds: ["Telugu voice", "News Drops on what you love", "750 Aura a month"] },
  { id: "final_boss", name: "Final Boss", price: 599, aura: 1500, tone: "orange", tagline: "It works while you sleep.", adds: ["Autonomous agents", "Higher limits", "1,500 Aura a month"] },
  { id: "god_mode", name: "God Mode", price: 1999, aura: 5000, tone: "lilac", tagline: "No ceiling.", adds: ["Top limits", "Early features first", "5,000 Aura a month"] },
] as const;

export type PlanId = (typeof PLANS)[number]["id"];

/** The cheapest plan that unlocks a feature. */
export const UNLOCKED_BY: Record<Feature, PlanId> = {
  chat: "spawn",
  voice_en: "side_quest",
  lockin: "side_quest",
  voice_te: "main_character",
  news: "main_character",
  autonomy: "final_boss",
  early_access: "god_mode",
};
