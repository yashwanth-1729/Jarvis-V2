/**
 * Wires `GitHubStore` (store.ts) to the real world. Two ways to do it, for
 * two different trust models -- pick the one that matches where the code
 * actually runs, not the other way around:
 *
 *   `createGitHubStore`        reads direct (no credential -- a public repo
 *                              needs none), writes through the stateless
 *                              proxy in ../proxy/. For a web build: a
 *                              browser page served to arbitrary visitors
 *                              cannot hold a write-capable secret without
 *                              handing it to every one of them.
 *
 *   `createDirectGitHubStore`  reads AND writes straight to the GitHub API
 *                              using a token the CALLER already holds
 *                              locally. For desktop/Android: this is your
 *                              own app on your own device holding your own
 *                              credential, exactly the trust level the paid
 *                              app already gives the Supabase service key on
 *                              desktop (`backend/.env`, no proxy in front of
 *                              it). No proxy needed, no proxy deployment
 *                              required, one less moving part.
 *
 * Neither function is "more correct" than the other -- they're answers to
 * different questions ("can this code's own environment be read by someone
 * else?"). This is the only file in the library that performs actual
 * network I/O; everything else takes a `Store` and never knows or cares
 * whether it's backed by a network at all.
 */

import { GitHubStore, type GitHubRequest, type GitHubResponse, type Store } from "./store.js";

export interface GitHubClientOptions {
  /** e.g. "someuser/sldt-data" */
  repo: string;
  branch?: string;
  /** Namespaces every path this client touches -- must match the proxy's own allowlisted prefix. */
  pathPrefix: string;
  /** Base URL of the deployed write proxy (see ../proxy/), e.g. "https://sldt-proxy.example.workers.dev". Reads never go through it. */
  proxyBaseUrl: string;
  /** Overridable only for tests -- production code should never need to pass this. */
  fetchImpl?: typeof fetch;
}

export function createGitHubStore(options: GitHubClientOptions): Store {
  const fetchImpl = options.fetchImpl ?? fetch;
  const branch = options.branch ?? "main";

  return new GitHubStore({
    repo: options.repo,
    branch,
    pathPrefix: options.pathPrefix,
    request: (request: GitHubRequest) =>
      request.method === "GET"
        ? directRead(fetchImpl, options.repo, branch, request.path)
        : proxiedWrite(fetchImpl, options.proxyBaseUrl, options.repo, branch, request),
  });
}

export interface DirectGitHubClientOptions {
  /** e.g. "someuser/sldt-data" */
  repo: string;
  branch?: string;
  /** Namespaces every path this client touches. No proxy is involved, so nothing else enforces this -- it's just where this client keeps its own writes tidy within the repo. */
  pathPrefix: string;
  /**
   * A PAT with `Contents: Read and write` on this repo. Held entirely by
   * the caller (desktop's local settings, an Android keystore-backed
   * store, whatever) -- this function never persists it, logs it, or sends
   * it anywhere but api.github.com.
   */
  token: string;
  /** Overridable only for tests -- production code should never need to pass this. */
  fetchImpl?: typeof fetch;
}

/**
 * Store backed by direct, authenticated calls to GitHub's Contents API --
 * no proxy. Appropriate only where the caller's own environment is already
 * trusted with the token (a desktop process, a mobile app's own local
 * storage) -- never for code that ships to, or renders in, someone else's
 * browser. See the module doc above for the full reasoning.
 */
export function createDirectGitHubStore(options: DirectGitHubClientOptions): Store {
  const fetchImpl = options.fetchImpl ?? fetch;
  const branch = options.branch ?? "main";

  return new GitHubStore({
    repo: options.repo,
    branch,
    pathPrefix: options.pathPrefix,
    request: (request: GitHubRequest) =>
      request.method === "GET"
        ? directRead(fetchImpl, options.repo, branch, request.path, options.token)
        : directWrite(fetchImpl, options.repo, branch, request, options.token),
  });
}

async function directRead(
  fetchImpl: typeof fetch,
  repo: string,
  branch: string,
  path: string,
  token?: string,
): Promise<GitHubResponse> {
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`;
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `token ${token}` } : {}),
    },
  });
  if (response.status === 404) {
    return { status: 404 };
  }
  if (!response.ok) {
    return { status: response.status };
  }
  const body = (await response.json()) as { content?: string; sha?: string; encoding?: string };
  return {
    status: 200,
    // GitHub returns base64 content with embedded newlines every 60 chars; strip them.
    content: body.content?.replace(/\n/g, ""),
    sha: body.sha,
  };
}

async function directWrite(
  fetchImpl: typeof fetch,
  repo: string,
  branch: string,
  request: GitHubRequest,
  token: string,
): Promise<GitHubResponse> {
  if (!request.body) {
    throw new Error("PUT request missing body");
  }
  const response = await fetchImpl(
    `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(request.path).replace(/%2F/g, "/")}`,
    {
      method: "PUT",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: request.body.message,
        content: request.body.content,
        branch,
        ...(request.body.sha !== null ? { sha: request.body.sha } : {}),
      }),
    },
  );
  if (response.status === 409 || response.status === 422) {
    return { status: response.status };
  }
  if (!response.ok) {
    return { status: response.status };
  }
  const body = (await response.json()) as { content?: { sha?: string } };
  return { status: response.status, sha: body.content?.sha };
}

async function proxiedWrite(
  fetchImpl: typeof fetch,
  proxyBaseUrl: string,
  _repo: string,
  _branch: string,
  request: GitHubRequest,
): Promise<GitHubResponse> {
  if (!request.body) {
    throw new Error("PUT request missing body");
  }
  // Deliberately NOT sending repo/branch: the proxy is single-tenant, its
  // target repo fixed by its own server-side config. A client that could
  // name the destination repo could redirect writes anywhere the proxy's
  // credential reaches -- see jarvis-oss/proxy/README.md.
  const response = await fetchImpl(`${proxyBaseUrl.replace(/\/+$/, "")}/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: request.path,
      content: request.body.content,
      sha: request.body.sha,
      message: request.body.message,
    }),
  });
  if (response.status === 409 || response.status === 422) {
    return { status: response.status };
  }
  if (!response.ok) {
    return { status: response.status };
  }
  const body = (await response.json()) as { sha?: string };
  return { status: response.status, sha: body.sha };
}
