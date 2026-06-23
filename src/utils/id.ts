/** Canonicalize a document id to a stable string for keys and set comparison. */
export function idToString(id: unknown): string | undefined {
  if (id === null || id === undefined) return undefined;
  if (typeof id === "string") return id;
  if (typeof id === "number") return String(id);
  if (id instanceof Date) return id.toISOString();
  if (
    typeof id === "object" &&
    (id as { _bsontype?: unknown })._bsontype === "ObjectId" &&
    typeof (id as { toHexString?: unknown }).toHexString === "function"
  ) {
    return (id as { toHexString(): string }).toHexString();
  }
  return String(id);
}
