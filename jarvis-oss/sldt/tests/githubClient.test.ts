/**
 * `githubClient.ts` with `fetch` mocked -- no network, no credential needed.
 * Covers both trust models: the proxied path (`createGitHubStore`) and the
 * direct-write path (`createDirectGitHubStore`), including the request
 * shapes each actually sends (this file had no unit coverage before; it had
 * only ever been exercised by a live round trip against the real API).
 *
 *     npx tsx tests/githubClient.test.ts
 */

import { createDirectGitHubStore, createGitHubStore } from "../src/githubClient.js";
import { check, summarize } from "./_harness.js";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(responses: Array<{ status: number; body: unknown }>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function main() {
  // --- createGitHubStore: reads go direct, unauthenticated ---
  {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { content: "aGVsbG8=", sha: "abc123" } }]);
    const store = createGitHubStore({ repo: "user/repo", pathPrefix: "sldt/", proxyBaseUrl: "http://localhost:8787", fetchImpl });
    const result = await store.get("manifest.json");
    check("proxied store's read hits api.github.com directly", calls[0].url.includes("api.github.com"));
    check("proxied store's read sends no Authorization header", !("Authorization" in (calls[0].init?.headers ?? {})));
    check("read result carries the sha", result?.version === "abc123");
  }

  // --- createGitHubStore: writes go through the proxy, never straight to GitHub ---
  {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, body: { sha: "newsha" } }]);
    const store = createGitHubStore({ repo: "user/repo", pathPrefix: "sldt/", proxyBaseUrl: "http://localhost:8787/", fetchImpl });
    const newVersion = await store.put("objects/x.enc", new TextEncoder().encode("cyphertext"), null);
    check("proxied store's write hits the proxy, not GitHub directly", calls[0].url === "http://localhost:8787/write");
    check("proxied write's body carries no repo/branch (single-tenant proxy, fixed server-side)", (() => {
      const body = JSON.parse(String(calls[0].init?.body));
      return !("repo" in body) && !("branch" in body);
    })());
    check("proxied write's body is exactly the allowlisted shape", (() => {
      const body = JSON.parse(String(calls[0].init?.body));
      return Object.keys(body).sort().join(",") === "content,message,path,sha";
    })());
    check("proxied write returns the new sha", newVersion === "newsha");
  }

  // --- createDirectGitHubStore: both reads and writes are authenticated, straight to GitHub ---
  {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, body: { content: "aGVsbG8=", sha: "readsha" } },
      { status: 200, body: { content: { sha: "writesha" } } },
    ]);
    const store = createDirectGitHubStore({
      repo: "user/repo",
      pathPrefix: "sldt/",
      token: "fake-token-not-real",
      fetchImpl,
    });

    const readResult = await store.get("manifest.json");
    check("direct store's read hits api.github.com", calls[0].url.includes("api.github.com"));
    check(
      "direct store's read is authenticated with the token",
      (calls[0].init?.headers as Record<string, string>)?.Authorization === "token fake-token-not-real",
    );
    check("direct read result carries the sha", readResult?.version === "readsha");

    const newVersion = await store.put("objects/x.enc", new TextEncoder().encode("cyphertext"), "readsha");
    check("direct store's write goes straight to api.github.com, not a proxy", calls[1].url.includes("api.github.com"));
    check(
      "direct write is authenticated with the token",
      (calls[1].init?.headers as Record<string, string>)?.Authorization === "token fake-token-not-real",
    );
    check("direct write's body includes the CAS sha when updating an existing object", (() => {
      const body = JSON.parse(String(calls[1].init?.body));
      return body.sha === "readsha" && body.branch === "main";
    })());
    check("direct write returns the new sha", newVersion === "writesha");
  }

  // --- createDirectGitHubStore: creating a brand-new object omits sha entirely ---
  {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, body: { content: { sha: "firstsha" } } }]);
    const store = createDirectGitHubStore({ repo: "user/repo", pathPrefix: "sldt/", token: "t", fetchImpl });
    await store.put("objects/new.enc", new TextEncoder().encode("x"), null);
    check("creating a new object's PUT body has no sha field at all", (() => {
      const body = JSON.parse(String(calls[0].init?.body));
      return !("sha" in body);
    })());
  }

  // --- createDirectGitHubStore: a CAS conflict is reported as ConcurrentWriteConflict, not swallowed ---
  {
    const { fetchImpl } = fakeFetch([{ status: 409, body: { message: "sha mismatch, ignored by directWrite's mapping" } }]);
    const store = createDirectGitHubStore({ repo: "user/repo", pathPrefix: "sldt/", token: "t", fetchImpl });
    let threw = false;
    try {
      await store.put("objects/x.enc", new TextEncoder().encode("x"), "stale-sha");
    } catch (error) {
      threw = (error as Error).name === "ConcurrentWriteConflict";
    }
    check("a 409 from GitHub surfaces as ConcurrentWriteConflict", threw);
  }

  summarize("githubClient.test.ts");
}

main();
