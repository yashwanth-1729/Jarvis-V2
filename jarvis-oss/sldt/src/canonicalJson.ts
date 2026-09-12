/**
 * Deterministic JSON serialization for anything that gets HMAC-signed.
 *
 * `JSON.stringify` preserves insertion order for string keys, so two devices
 * that built the same logical manifest by inserting keys in a different order
 * would sign different bytes and fail each other's verification -- a spurious
 * "tamper detected" that has nothing to do with tampering. Sorting keys
 * recursively removes that variable.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
