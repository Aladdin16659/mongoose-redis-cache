import { isSupportedPredicate, type Filter } from "./PredicateMatcher.js";

/**
 * Cacheability tiers. See plan.md "Cacheability Tiers".
 *
 * - T0: point read keyed by document id — surgical invalidation.
 * - T1: predicate query we can evaluate in-memory — precise invalidation.
 * - T2: bounded but unpredicatable — conservative collection-tag invalidation.
 * - T3: aggregation — conservative by touched collection(s).
 * - T4: never cache (active session/transaction, cursor/streaming).
 */
export type Tier = "T0" | "T1" | "T2" | "T3" | "T4";

export interface ClassifyInput {
  op: string;
  filter?: Filter;
  hasSession?: boolean;
  isCursor?: boolean;
}

export function classifyQuery(input: ClassifyInput): Tier {
  // Never cache reads bound to a session/transaction or streamed via cursor.
  if (input.hasSession || input.isCursor) return "T4";

  if (input.op === "aggregate") return "T3";
  if (input.op === "estimatedDocumentCount") return "T2";
  if (input.op === "findById") return "T0";

  const filter = input.filter ?? {};

  if ((input.op === "find" || input.op === "findOne") && isPointRead(filter)) {
    return "T0";
  }

  return isSupportedPredicate(filter) ? "T1" : "T2";
}

function isPointRead(filter: Filter): boolean {
  const keys = Object.keys(filter);
  if (keys.length !== 1 || keys[0] !== "_id") return false;

  const value = filter._id;
  if (isOperatorObject(value)) {
    const opKeys = Object.keys(value);
    return opKeys.length === 1 && opKeys[0] === "$in" && Array.isArray(value.$in);
  }
  // Scalar / ObjectId / Date equality on _id.
  return true;
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    Object.keys(value).length > 0 &&
    Object.keys(value).every((k) => k.startsWith("$"))
  );
}
