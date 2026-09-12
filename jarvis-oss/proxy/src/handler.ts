/**
 * The one operation this proxy performs: forward an allowlisted-shape write
 * to GitHub's Contents API. Never decrypts, never logs plaintext, never
 * accepts a field it doesn't recognize -- a request with any extra field is
 * rejected outright, which is the safety net against a client bug ever
 * sending something it shouldn't through this path.
 */

import type { ProxyConfig } from "./config.js";

export interface WriteRequestBody {
  path: string;
  /** Base64 ciphertext -- opaque to this proxy. Never inspected beyond its length for logging. */
  content: string;
  /** Expected blob sha for the CAS write, or null to require the path not already exist. */
  sha: string | null;
  message: string;
}

const ALLOWED_KEYS = new Set(["path", "content", "sha", "message"]);

export interface ProxyResult {
  status: number;
  body: { sha?: string } | { error: string };
}

export type Logger = (line: string) => void;

/** Rejects anything that isn't exactly `{path, content, sha, message}` with the right types. */
export function validateShape(input: unknown): input is WriteRequestBody {
  if (typeof input !== "object" || input === null) return false;
  const keys = Object.keys(input);
  if (keys.length !== ALLOWED_KEYS.size || !keys.every((k) => ALLOWED_KEYS.has(k))) return false;
  const body = input as Record<string, unknown>;
  return (
    typeof body.path === "string" &&
    body.path.length > 0 &&
    typeof body.content === "string" &&
    (body.sha === null || typeof body.sha === "string") &&
    typeof body.message === "string"
  );
}

/** The path namespace restriction: prevents this proxy from becoming a generic write-anything relay. */
export function isAllowedPath(path: string, prefix: string): boolean {
  if (path.includes("..")) return false; // no traversal, even within the allowed prefix
  return path.startsWith(prefix);
}

export async function handleWrite(
  rawBody: unknown,
  config: ProxyConfig,
  log: Logger,
  githubFetch: typeof fetch = fetch,
): Promise<ProxyResult> {
  if (!validateShape(rawBody)) {
    log("write rejected: shape=invalid");
    return { status: 400, body: { error: "request body must be exactly {path, content, sha, message}" } };
  }

  const { path, content, sha, message } = rawBody;

  if (!isAllowedPath(path, config.pathPrefix)) {
    // Log the shape of the rejection, not an accusatory echo of the path --
    // still useful as an audit trail without amplifying whatever a caller sent.
    log(`write rejected: path outside allowed prefix (prefix=${config.pathPrefix})`);
    return { status: 403, body: { error: `path must start with "${config.pathPrefix}"` } };
  }

  log(`write forwarded: path=${path} contentBytes=${content.length} shaProvided=${sha !== null}`);

  const response = await githubFetch(
    `https://api.github.com/repos/${config.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
    {
      method: "PUT",
      headers: {
        Authorization: `token ${config.githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        content,
        branch: config.branch,
        ...(sha !== null ? { sha } : {}),
      }),
    },
  );

  if (response.status === 409 || response.status === 422) {
    log(`write conflict: path=${path} status=${response.status}`);
    return { status: response.status, body: { error: "compare-and-swap conflict" } };
  }

  if (!response.ok) {
    log(`write failed: path=${path} status=${response.status}`);
    return { status: response.status, body: { error: "upstream write failed" } };
  }

  const json = (await response.json()) as { content?: { sha?: string } };
  const newSha = json.content?.sha;
  log(`write succeeded: path=${path} status=${response.status}`);
  return { status: response.status, body: { sha: newSha } };
}
