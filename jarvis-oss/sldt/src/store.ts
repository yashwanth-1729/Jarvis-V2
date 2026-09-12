/**
 * The storage substrate abstraction: a dumb, publicly-addressable object
 * store that supports get-by-path and compare-and-swap write. Nothing in
 * here knows what sync means -- that's `sync.ts`. This file only knows how
 * to read and conditionally write opaque bytes at a path.
 */

import { ConcurrentWriteConflict } from "./errors.js";

export interface StoredObject {
  /** Raw bytes at this path -- opaque to the store, meaningful only to the client. */
  content: Uint8Array;
  /** Opaque version token (a git blob SHA for GitHubStore). Required for a CAS write. */
  version: string;
}

/**
 * A publicly-addressable, versioned object store with one required primitive:
 * compare-and-swap on write. Implementations may be a GitHub repo, S3 with
 * object versioning, IPFS with a mutable pointer, etc.
 */
export interface Store {
  /** Returns null if nothing exists at this path yet. */
  get(path: string): Promise<StoredObject | null>;
  /**
   * Write `content` to `path`. `expectedVersion` must be the version last
   * read from this path (or null for "must not exist yet"); if the store's
   * current version differs, the write is rejected with
   * `ConcurrentWriteConflict` rather than silently overwriting a concurrent
   * writer's change.
   */
  put(path: string, content: Uint8Array, expectedVersion: string | null): Promise<string>;
}

/** In-process store for unit tests and multi-"device" simulation -- no network, deterministic. */
export class InMemoryStore implements Store {
  private objects = new Map<string, StoredObject>();
  private revisionCounter = 0;

  async get(path: string): Promise<StoredObject | null> {
    const existing = this.objects.get(path);
    return existing ? { content: existing.content.slice(), version: existing.version } : null;
  }

  async put(path: string, content: Uint8Array, expectedVersion: string | null): Promise<string> {
    const existing = this.objects.get(path);
    const currentVersion = existing?.version ?? null;
    if (currentVersion !== expectedVersion) {
      throw new ConcurrentWriteConflict(path);
    }
    const newVersion = `v${++this.revisionCounter}`;
    this.objects.set(path, { content: content.slice(), version: newVersion });
    return newVersion;
  }
}

export interface GitHubStoreOptions {
  /** e.g. "someuser/sldt-data" */
  repo: string;
  branch?: string;
  /** Every path this store touches is namespaced under this prefix, so a shared write proxy can allowlist it. */
  pathPrefix?: string;
  /**
   * Function that performs the actual authenticated request -- points either
   * at the GitHub Contents API directly (desktop, holding its own PAT) or at
   * the one stateless write proxy described in the SLDT design (browser
   * clients that can't hold a PAT). This store never sees or handles the
   * credential itself.
   */
  request: (input: GitHubRequest) => Promise<GitHubResponse>;
}

export interface GitHubRequest {
  method: "GET" | "PUT";
  path: string;
  /** Only set for PUT: base64 content, expected blob sha, and a commit message -- the exact allowlisted shape the proxy accepts. */
  body?: { content: string; sha: string | null; message: string };
}

export interface GitHubResponse {
  status: number;
  /** Base64 file content, present on a successful GET. */
  content?: string;
  /** Blob sha, present on a successful GET or PUT. */
  sha?: string;
}

/**
 * Talks to the GitHub Contents API (or a proxy with the same shape) to
 * implement `Store` on top of a git repo. Never inspects plaintext -- it
 * only ever sees ciphertext bytes handed to it by the sync engine.
 */
export class GitHubStore implements Store {
  constructor(private readonly options: GitHubStoreOptions) {}

  private fullPath(path: string): string {
    const prefix = this.options.pathPrefix?.replace(/\/+$/, "");
    return prefix ? `${prefix}/${path}` : path;
  }

  async get(path: string): Promise<StoredObject | null> {
    const response = await this.options.request({ method: "GET", path: this.fullPath(path) });
    if (response.status === 404) return null;
    if (response.status !== 200 || !response.content || !response.sha) {
      throw new Error(`unexpected response reading ${path}: status ${response.status}`);
    }
    const binary = base64ToBytes(response.content);
    return { content: binary, version: response.sha };
  }

  async put(path: string, content: Uint8Array, expectedVersion: string | null): Promise<string> {
    const response = await this.options.request({
      method: "PUT",
      path: this.fullPath(path),
      body: {
        content: bytesToBase64(content),
        sha: expectedVersion,
        message: `sldt: update ${path}`,
      },
    });
    if (response.status === 409 || response.status === 422) {
      throw new ConcurrentWriteConflict(path);
    }
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`unexpected response writing ${path}: status ${response.status}`);
    }
    if (!response.sha) {
      throw new Error(`write to ${path} did not return a new sha`);
    }
    return response.sha;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
