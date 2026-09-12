/**
 * Server-side configuration, read once from environment variables. The
 * credential lives here and nowhere else in this process's reachable code --
 * no client request can ever influence which repo or branch gets written to,
 * which is what keeps this proxy from becoming a generic write-anything
 * relay for whoever can reach its URL.
 */

export interface ProxyConfig {
  githubToken: string;
  repo: string;
  branch: string;
  /** Every path this proxy will write to must start with this prefix. */
  pathPrefix: string;
  /** Optional CORS allowlist -- undefined means same-origin only (safe default for a same-app deployment). */
  allowedOrigin: string | undefined;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const githubToken = required(env, "GITHUB_TOKEN");
  const repo = required(env, "GITHUB_REPO");
  const branch = env.GITHUB_BRANCH?.trim() || "main";
  const pathPrefix = normalizePrefix(env.SLDT_PATH_PREFIX?.trim() || "sldt/");
  const allowedOrigin = env.SLDT_ALLOWED_ORIGIN?.trim() || undefined;
  const port = Number.parseInt(env.PORT ?? "8787", 10);

  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    throw new Error(`GITHUB_REPO must be "owner/repo", got: ${repo}`);
  }

  return { githubToken, repo, branch, pathPrefix, allowedOrigin, port };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing required environment variable: ${key}`);
  return value;
}

function normalizePrefix(prefix: string): string {
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}
