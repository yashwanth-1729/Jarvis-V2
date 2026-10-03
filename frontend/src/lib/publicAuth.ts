/**
 * Sign-in for the public edition, straight against Supabase Auth's REST API
 * (no SDK, the same way lib/syncClient talks to Supabase).
 *
 * Email one-time codes, deliberately. They work inside the Android WebView,
 * where Google blocks OAuth pop-ups, and need no SMS provider. Phone OTP and
 * native Google sign-in can join later behind the same session shape.
 *
 * The session lives in localStorage. Its access token is handed to the
 * on-device backend (/api/local/credentials), which uses it as the bearer for
 * the HOLO gateway, and to the gateway directly for plan and Aura.
 */

export const HOLO_SUPABASE_URL = (process.env.NEXT_PUBLIC_HOLO_SUPABASE_URL ?? "").replace(/\/+$/, "");
export const HOLO_SUPABASE_KEY = process.env.NEXT_PUBLIC_HOLO_SUPABASE_KEY ?? "";
export const HOLO_GATEWAY_URL = (process.env.NEXT_PUBLIC_HOLO_GATEWAY_URL ?? "").replace(/\/+$/, "");

/** Whether this build knows where to sign in at all. */
export const AUTH_CONFIGURED = Boolean(HOLO_SUPABASE_URL && HOLO_SUPABASE_KEY);

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  user: { id: string; email: string | null };
}

const KEY = "jarvis.public.session";

export function loadSession(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function storeSession(session: Session | null): void {
  try {
    if (session) window.localStorage.setItem(KEY, JSON.stringify(session));
    else window.localStorage.removeItem(KEY);
  } catch {
    // A full or blocked store only costs a re-sign-in next launch.
  }
}

export class AuthError extends Error {}

async function auth(path: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
  if (!AUTH_CONFIGURED) throw new AuthError("Sign-in isn't switched on in this build yet.");
  let response: Response;
  try {
    response = await fetch(`${HOLO_SUPABASE_URL}/auth/v1${path}`, {
      method: "POST",
      headers: {
        apikey: HOLO_SUPABASE_KEY,
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthError("Can't reach sign-in. Check your connection.");
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = String(data.msg ?? data.error_description ?? data.message ?? "");
    if (response.status === 429) throw new AuthError("Too many tries. Give it a minute.");
    if (/expired|invalid/i.test(message)) throw new AuthError("That code didn't work. Check it or send a new one.");
    throw new AuthError(message || `Sign-in failed (${response.status}).`);
  }
  return data;
}

function toSession(data: Record<string, unknown>): Session {
  const user = (data.user ?? {}) as { id?: string; email?: string };
  const expiresIn = Number(data.expires_in ?? 3600);
  return {
    accessToken: String(data.access_token ?? ""),
    refreshToken: String(data.refresh_token ?? ""),
    expiresAt: Date.now() + expiresIn * 1000,
    user: { id: String(user.id ?? ""), email: user.email ?? null },
  };
}

/** Email a 6-digit code; creates the account on first use. */
export async function sendEmailCode(email: string): Promise<void> {
  await auth("/otp", { email: email.trim().toLowerCase(), create_user: true });
}

export async function verifyEmailCode(email: string, code: string): Promise<Session> {
  const data = await auth("/verify", { type: "email", email: email.trim().toLowerCase(), token: code.trim() });
  const session = toSession(data);
  if (!session.accessToken) throw new AuthError("Sign-in didn't return a session. Try again.");
  storeSession(session);
  return session;
}

export async function refreshSession(session: Session): Promise<Session> {
  const data = await auth("/token?grant_type=refresh_token", { refresh_token: session.refreshToken });
  const next = toSession(data);
  storeSession(next);
  return next;
}

export async function signOut(session: Session | null): Promise<void> {
  if (session && AUTH_CONFIGURED) {
    await auth("/logout", {}, session.accessToken).catch(() => undefined);
  }
  storeSession(null);
}
