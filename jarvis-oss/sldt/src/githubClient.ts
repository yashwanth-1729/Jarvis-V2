/**
 * Wires `GitHubStore` (store.ts) to the real world: reads go straight to the
 * public GitHub Contents API (no credential needed for a public repo), and
 * writes go through the one stateless proxy that holds the write credential
 * a browser can't safely hold. This is the only file in the library that
 * performs actual network I/O -- everything else takes a `Store` and never
 * knows or cares whether it's backed by a network at all.
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

async function directRead(
  fetchImpl: typeof fetch,
  repo: string,
  branch: string,
  path: string,
): Promise<GitHubResponse> {
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`;
  const response = await fetchImpl(url, {
    headers: { Accept: "application/vnd.github+json" },
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
