/**
 * Proxy handler logic, with GitHub's API mocked out -- no network, no
 * credential needed, no live calls. Covers the allowlist behaviors that
 * actually matter: shape rejection, path-prefix restriction, and the
 * CAS-conflict passthrough.
 *
 *     npx tsx tests/handler.test.ts
 */

import type { ProxyConfig } from "../src/config.js";
import { handleWrite, isAllowedPath, validateShape } from "../src/handler.js";
import { check, summarize } from "./_harness.js";

const config: ProxyConfig = {
  githubToken: "fake-token-not-real",
  repo: "someuser/sldt-data",
  branch: "main",
  pathPrefix: "sldt/",
  allowedOrigin: undefined,
  port: 8787,
};

function noopLog(): void {}

function fakeGithubFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

async function main() {
  check(
    "validateShape accepts exactly {path, content, sha, message}",
    validateShape({ path: "sldt/objects/x.enc", content: "abc", sha: null, message: "m" }),
  );
  check(
    "validateShape rejects an extra field",
    !validateShape({ path: "sldt/x", content: "abc", sha: null, message: "m", extra: "nope" }),
  );
  check("validateShape rejects a missing field", !validateShape({ path: "sldt/x", content: "abc", sha: null }));
  check("validateShape rejects wrong types", !validateShape({ path: "sldt/x", content: 123, sha: null, message: "m" }));
  check("validateShape rejects non-objects", !validateShape("not an object"));
  check("validateShape rejects null", !validateShape(null));

  check("isAllowedPath accepts a path under the prefix", isAllowedPath("sldt/objects/a.enc", "sldt/"));
  check("isAllowedPath rejects a path outside the prefix", !isAllowedPath("other/objects/a.enc", "sldt/"));
  check("isAllowedPath rejects path traversal even under the prefix", !isAllowedPath("sldt/../secrets.env", "sldt/"));

  const shapeRejected = await handleWrite({ path: "sldt/x", content: "c", extra: 1 }, config, noopLog);
  check("handleWrite rejects a bad shape with 400", shapeRejected.status === 400);

  const pathRejected = await handleWrite(
    { path: "other/x", content: "c", sha: null, message: "m" },
    config,
    noopLog,
  );
  check("handleWrite rejects a disallowed path with 403", pathRejected.status === 403);

  const success = await handleWrite(
    { path: "sldt/objects/task-1.enc", content: "Y2lwaGVydGV4dA==", sha: null, message: "sldt: update task-1" },
    config,
    noopLog,
    fakeGithubFetch(201, { content: { sha: "newsha123" } }),
  );
  check("handleWrite forwards a valid write and returns the new sha", success.status === 201);
  check(
    "handleWrite's response body carries the new sha, not the content",
    (success.body as { sha?: string }).sha === "newsha123",
  );

  const conflict = await handleWrite(
    { path: "sldt/objects/task-1.enc", content: "Y2lwaGVydGV4dA==", sha: "stale-sha", message: "m" },
    config,
    noopLog,
    fakeGithubFetch(409, { message: "sha mismatch" }),
  );
  check("handleWrite passes through a CAS conflict as 409", conflict.status === 409);
  check(
    "handleWrite's conflict response never echoes GitHub's raw error body",
    !JSON.stringify(conflict.body).includes("sha mismatch"),
  );

  summarize("handler.test.ts");
}

main();
