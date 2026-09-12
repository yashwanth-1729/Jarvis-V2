/**
 * Distinct failure modes the sync engine must never collapse into a generic
 * "sync failed" — each implies a different response (hard stop vs. skip one
 * object vs. retry).
 */

/** Manifest HMAC did not verify. Wrong key, or the store is lying. Hard stop. */
export class TamperDetected extends Error {
  constructor(message = "manifest signature verification failed") {
    super(message);
    this.name = "TamperDetected";
  }
}

/** Remote manifest revision is behind what this device already saw. Hard stop. */
export class ReplayDetected extends Error {
  constructor(
    public readonly localRevision: number,
    public readonly remoteRevision: number,
  ) {
    super(
      `remote manifest revision ${remoteRevision} is behind last-seen ${localRevision} -- possible rollback/replay`,
    );
    this.name = "ReplayDetected";
  }
}

/** A downloaded object's ciphertext hash does not match the manifest entry. Skip that object, don't crash the cycle. */
export class CorruptObject extends Error {
  constructor(public readonly objectId: string) {
    super(`object ${objectId} failed integrity check (hash mismatch)`);
    this.name = "CorruptObject";
  }
}

/** AES-GCM authentication failed on decrypt -- wrong key, or ciphertext was tampered with. */
export class DecryptionFailed extends Error {
  constructor(public readonly objectId: string) {
    super(`object ${objectId} failed to decrypt (wrong key or corrupted ciphertext)`);
    this.name = "DecryptionFailed";
  }
}

/** Compare-and-swap write lost the race to another device. Caller retries the whole cycle. */
export class ConcurrentWriteConflict extends Error {
  constructor(path: string) {
    super(`CAS write to ${path} lost a race with another writer`);
    this.name = "ConcurrentWriteConflict";
  }
}

/** Bounded retry budget for a sync cycle was exhausted, e.g. under sustained contention. */
export class SyncRetriesExhausted extends Error {
  constructor(attempts: number) {
    super(`sync cycle did not converge after ${attempts} attempts`);
    this.name = "SyncRetriesExhausted";
  }
}
