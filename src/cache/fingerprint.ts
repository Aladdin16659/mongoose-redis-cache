/**
 * Query fingerprinting: convert an arbitrary Mongoose query shape into a
 * deterministic, canonical structure suitable for hashing.
 *
 * Two semantically-equal queries (e.g. `{a:1,b:2}` and `{b:2,a:1}`) must
 * produce identical fingerprints. Special BSON-ish types (ObjectId, Date,
 * RegExp) are normalized to stable tagged forms.
 */
export function normalizeQuery(value: unknown): unknown {
  // Primitives and null/undefined pass through unchanged.
  if (value === null || typeof value !== "object") {
    return value;
  }

  // ObjectId (duck-typed so it works across bson copies bundled by mongoose).
  if (isObjectIdLike(value)) {
    return { $oid: value.toHexString() };
  }

  if (value instanceof Date) {
    return { $date: value.toISOString() };
  }

  if (value instanceof RegExp) {
    return { $regex: value.source, $options: value.flags };
  }

  // Arrays are ordered semantically — preserve order, normalize each element.
  if (Array.isArray(value)) {
    return value.map((el) => normalizeQuery(el));
  }

  // Plain objects: sort keys for determinism, normalize values recursively.
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = normalizeQuery((value as Record<string, unknown>)[key]);
  }
  return out;
}

interface ObjectIdLike {
  _bsontype: "ObjectId";
  toHexString(): string;
}

function isObjectIdLike(value: object): value is ObjectIdLike {
  return (
    (value as { _bsontype?: unknown })._bsontype === "ObjectId" &&
    typeof (value as { toHexString?: unknown }).toHexString === "function"
  );
}
