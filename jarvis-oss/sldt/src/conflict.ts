/**
 * Deterministic conflict resolution: two devices that independently see the
 * same two candidate revisions must reach the same answer with no
 * coordination. That rules out wall-clock time (unsynchronized across
 * devices, and trivially manipulable) and "whoever pushes first" (a race,
 * not a rule -- non-deterministic and lossy). Revision number, then a stable
 * tiebreaker, is the only thing every device can compute identically from
 * data alone.
 */

export interface RevisionedCandidate {
  revision: number;
  deviceId: string;
}

/** Returns the winner of two candidate revisions of the same object. Never a coin flip. */
export function resolveConflict<T extends RevisionedCandidate>(a: T, b: T): T {
  if (a.revision !== b.revision) {
    return a.revision > b.revision ? a : b;
  }
  // Equal revision: tie-break on deviceId, a value both sides already hold
  // and neither can influence after the fact.
  return a.deviceId >= b.deviceId ? a : b;
}
