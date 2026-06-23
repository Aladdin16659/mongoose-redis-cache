import { normalizeQuery } from "../cache/fingerprint.js";

/**
 * In-memory evaluation of a MongoDB filter against a single plain document.
 *
 * This is the engine that powers precise (T1) invalidation: on a write we
 * evaluate whether a document entered or left a cached query's result set.
 *
 * CRITICAL CORRECTNESS CONTRACT: `matches` must agree with MongoDB's matching
 * semantics for every operator that {@link isSupportedPredicate} accepts. A
 * predicate using any operator we cannot faithfully evaluate must be rejected
 * by `isSupportedPredicate` so the tier classifier downgrades it to T2
 * (collection-tag invalidation) rather than risk a missed invalidation.
 */
export type Filter = Record<string, unknown>;
export type Doc = Record<string, unknown>;

const LOGICAL_OPERATORS = new Set(["$and", "$or", "$nor"]);
const FIELD_OPERATORS = new Set([
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
  "$exists",
  "$not",
]);

// ---------------------------------------------------------------------------
// matches
// ---------------------------------------------------------------------------

export function matches(filter: Filter, doc: Doc): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === "$and") {
      if (!(condition as Filter[]).every((sub) => matches(sub, doc))) return false;
    } else if (key === "$or") {
      if (!(condition as Filter[]).some((sub) => matches(sub, doc))) return false;
    } else if (key === "$nor") {
      if ((condition as Filter[]).some((sub) => matches(sub, doc))) return false;
    } else {
      const resolved = resolvePath(doc, key);
      if (!fieldMatches(resolved, condition)) return false;
    }
  }
  return true;
}

interface Resolved {
  exists: boolean;
  value: unknown;
}

function resolvePath(doc: unknown, path: string): Resolved {
  const segments = path.split(".");
  let current: unknown = doc;
  for (const seg of segments) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return { exists: false, value: undefined };
    }
    if (!(seg in (current as Record<string, unknown>))) {
      return { exists: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[seg];
  }
  return { exists: true, value: current };
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

function fieldMatches(resolved: Resolved, condition: unknown): boolean {
  if (isOperatorObject(condition)) {
    return Object.entries(condition).every(([op, operand]) =>
      operatorMatches(resolved, op, operand),
    );
  }
  return equals(resolved, condition);
}

function operatorMatches(resolved: Resolved, op: string, operand: unknown): boolean {
  switch (op) {
    case "$eq":
      return equals(resolved, operand);
    case "$ne":
      return !equals(resolved, operand);
    case "$in":
      return (operand as unknown[]).some((o) => equals(resolved, o));
    case "$nin":
      return !(operand as unknown[]).some((o) => equals(resolved, o));
    case "$exists":
      return resolved.exists === (operand as boolean);
    case "$not":
      return !fieldMatches(resolved, operand);
    case "$gt":
    case "$gte":
    case "$lt":
    case "$lte":
      return compare(resolved.value, op, operand);
    default:
      // Unreachable for supported predicates; conservative non-match.
      return false;
  }
}

/** Mongo equality, including array-contains and null/missing semantics. */
function equals(resolved: Resolved, target: unknown): boolean {
  if (target === null) {
    // $eq null matches an explicit null OR a missing field.
    return !resolved.exists || resolved.value === null;
  }
  if (!resolved.exists) return false;
  const fv = resolved.value;
  if (Array.isArray(fv) && fv.some((el) => scalarEquals(el, target))) {
    return true;
  }
  return scalarEquals(fv, target);
}

function scalarEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  return JSON.stringify(normalizeQuery(value));
}

/** Ordered comparison for numbers, Dates, and strings; array-aware. */
function compare(fieldValue: unknown, op: string, operand: unknown): boolean {
  if (Array.isArray(fieldValue)) {
    return fieldValue.some((el) => compareScalar(el, op, operand));
  }
  return compareScalar(fieldValue, op, operand);
}

function compareScalar(a: unknown, op: string, b: unknown): boolean {
  const left = toComparable(a);
  const right = toComparable(b);
  if (left === null || right === null || typeof left !== typeof right) {
    // Cross-type or non-orderable: no match (Mongo would treat differently,
    // but such filters are out of the supported T1 boundary in practice).
    return false;
  }
  switch (op) {
    case "$gt":
      return left > right;
    case "$gte":
      return left >= right;
    case "$lt":
      return left < right;
    case "$lte":
      return left <= right;
    default:
      return false;
  }
}

function toComparable(value: unknown): number | string | null {
  if (typeof value === "number" || typeof value === "string") return value;
  if (value instanceof Date) return value.getTime();
  return null;
}

// ---------------------------------------------------------------------------
// isSupportedPredicate — the T1 soundness boundary
// ---------------------------------------------------------------------------

export function isSupportedPredicate(filter: unknown): boolean {
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
    return false;
  }
  for (const [key, condition] of Object.entries(filter)) {
    if (LOGICAL_OPERATORS.has(key)) {
      if (!Array.isArray(condition)) return false;
      if (!condition.every((sub) => isSupportedPredicate(sub))) return false;
    } else if (key.startsWith("$")) {
      // Any other top-level $operator ($where, $text, $expr, ...) is unsupported.
      return false;
    } else if (!isSupportedCondition(condition)) {
      return false;
    }
  }
  return true;
}

function isSupportedCondition(condition: unknown): boolean {
  if (condition instanceof RegExp) return false;
  if (isOperatorObject(condition)) {
    return Object.entries(condition).every(([op, operand]) => {
      if (!FIELD_OPERATORS.has(op)) return false;
      if (op === "$not") return isOperatorObject(operand) && isSupportedCondition(operand);
      if (op === "$in" || op === "$nin") {
        // A RegExp element means pattern matching, which our equality-based
        // evaluation cannot reproduce — reject so the query downgrades to T2.
        return (
          Array.isArray(operand) && !operand.some((el) => el instanceof RegExp)
        );
      }
      if (op === "$exists") return typeof operand === "boolean";
      return true;
    });
  }
  // Plain equality to a non-regex literal is always supported.
  return true;
}
