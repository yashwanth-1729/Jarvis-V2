import type { MemoryStatus, MemoryType } from "@/types";

export const MEMORY_FRONT_MATTER_VERSION = 2;

export interface MemoryMetadata {
  jarvis_memory: 2;
  type: MemoryType;
  status: MemoryStatus;
  confidence: number;
  importance: number;
  source_kind: string;
  source_ref: string | null;
  valid_from: string | null;
  supersedes_uid: string | null;
  pinned: boolean;
  evidence_count: number;
  tags: string[];
  history: Array<{content?: string; updated_at?: string; source_kind?: string; source_ref?: string | null}>;
}

const TYPES = new Set<MemoryType>(["WORKING", "EPISODIC", "SEMANTIC", "PROCEDURAL", "PROSPECTIVE", "REFLECTIVE"]);
const STATUSES = new Set<MemoryStatus>(["ACTIVE", "CANDIDATE", "SUPERSEDED", "ARCHIVED"]);
const ORDER: Array<keyof MemoryMetadata> = [
  "jarvis_memory", "type", "status", "confidence", "importance", "source_kind",
  "source_ref", "valid_from", "supersedes_uid", "pinned", "evidence_count", "tags", "history",
];

const clamp = (value: unknown, fallback: number) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
};

export function inferredMemoryType(category?: unknown, expiresAt?: unknown): MemoryType {
  if (expiresAt) return "PROCEDURAL";
  if (String(category ?? "").toUpperCase() === "GOAL") return "PROSPECTIVE";
  return "SEMANTIC";
}

export function defaultMemoryMetadata(options: {
  category?: unknown;
  expiresAt?: unknown;
  createdAt?: unknown;
} = {}): MemoryMetadata {
  return {
    jarvis_memory: 2,
    type: inferredMemoryType(options.category, options.expiresAt),
    status: "ACTIVE",
    confidence: 1,
    importance: 0.65,
    source_kind: options.createdAt ? "legacy" : "explicit",
    source_ref: null,
    valid_from: options.createdAt ? String(options.createdAt) : null,
    supersedes_uid: null,
    pinned: false,
    evidence_count: 1,
    tags: [],
    history: [],
  };
}

function normalize(raw: Partial<MemoryMetadata>, fallback: MemoryMetadata): MemoryMetadata {
  const type = String(raw.type ?? fallback.type).toUpperCase() as MemoryType;
  const status = String(raw.status ?? fallback.status).toUpperCase() as MemoryStatus;
  return {
    ...fallback,
    ...raw,
    jarvis_memory: 2,
    type: TYPES.has(type) ? type : fallback.type,
    status: STATUSES.has(status) ? status : fallback.status,
    confidence: clamp(raw.confidence, fallback.confidence),
    importance: clamp(raw.importance, fallback.importance),
    pinned: Boolean(raw.pinned),
    evidence_count: Math.max(1, Number.parseInt(String(raw.evidence_count ?? 1), 10) || 1),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String).filter(Boolean).slice(0, 16) : [],
    history: Array.isArray(raw.history) ? raw.history.slice(-8) : [],
  };
}

export function decodeMemoryContent(stored: unknown, options: {
  category?: unknown;
  expiresAt?: unknown;
  createdAt?: unknown;
} = {}): {body: string; metadata: MemoryMetadata} {
  const text = String(stored ?? "");
  const fallback = defaultMemoryMetadata(options);
  if (!text.startsWith("---\n")) return {body: text, metadata: fallback};
  const marker = text.indexOf("\n---\n", 4);
  if (marker < 0) return {body: text, metadata: fallback};
  try {
    const raw: Record<string, unknown> = {};
    for (const line of text.slice(4, marker).split("\n")) {
      const split = line.indexOf(":");
      if (split < 0) continue;
      raw[line.slice(0, split).trim()] = JSON.parse(line.slice(split + 1).trim());
    }
    if (raw.jarvis_memory !== 2) return {body: text, metadata: fallback};
    return {body: text.slice(marker + 5), metadata: normalize(raw as Partial<MemoryMetadata>, fallback)};
  } catch {
    return {body: text, metadata: fallback};
  }
}

export function encodeMemoryContent(body: string, metadata: Partial<MemoryMetadata> = {}): string {
  const normalized = normalize(metadata, defaultMemoryMetadata());
  const lines = ["---"];
  for (const key of ORDER) lines.push(`${key}: ${JSON.stringify(normalized[key])}`);
  lines.push("---", body.trim());
  return lines.join("\n");
}

export function reviseMemoryContent(
  stored: unknown,
  body: string,
  metadata: Partial<MemoryMetadata>,
  options: {category?: unknown; expiresAt?: unknown; createdAt?: unknown; updatedAt?: unknown} = {},
): string {
  const current = decodeMemoryContent(stored, options);
  const history = [...current.metadata.history];
  if (current.body.trim() && current.body.trim() !== body.trim()) {
    history.push({
      content: current.body.slice(0, 4000),
      updated_at: options.updatedAt ? String(options.updatedAt) : undefined,
      source_kind: current.metadata.source_kind,
      source_ref: current.metadata.source_ref,
    });
  }
  const supplied = Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  ) as Partial<MemoryMetadata>;
  return encodeMemoryContent(body, {...current.metadata, ...supplied, history: history.slice(-8)});
}

export function upgradeMemoryContent(stored: unknown, options: {
  category?: unknown;
  expiresAt?: unknown;
  createdAt?: unknown;
} = {}): string {
  const decoded = decodeMemoryContent(stored, options);
  if (String(stored ?? "").startsWith("---\njarvis_memory: 2\n")) return String(stored ?? "");
  return encodeMemoryContent(decoded.body, decoded.metadata);
}
