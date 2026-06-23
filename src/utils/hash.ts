import { createHash } from "node:crypto";
import { normalizeQuery } from "../cache/fingerprint.js";

/**
 * Deterministic hash of an arbitrary value. The value is first canonicalized
 * via {@link normalizeQuery} so semantically-equal inputs hash identically,
 * then hashed with SHA-256 and truncated for compactness.
 */
export function stableHash(value: unknown): string {
  const canonical = JSON.stringify(normalizeQuery(value));
  return createHash("sha256")
    .update(canonical ?? "undefined")
    .digest("hex")
    .slice(0, 32);
}
