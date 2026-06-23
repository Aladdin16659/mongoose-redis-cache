import { BSON } from "bson";

/**
 * Lossless serialization of cache values. We never store hydrated Mongoose
 * documents — only plain (lean) data — but that data still contains BSON types
 * (ObjectId, Date, Decimal128, Buffer) that must survive a Redis round-trip.
 *
 * Values are wrapped (`{ v: value }`) before BSON encoding so that arrays and
 * primitives — not just documents — can be stored.
 */
export function serialize(value: unknown): Buffer {
  const encoded = BSON.serialize({ v: value });
  return Buffer.from(encoded);
}

export function deserialize(buffer: Buffer): unknown {
  const decoded = BSON.deserialize(buffer, {
    promoteBuffers: true,
    promoteValues: true,
  });
  return (decoded as { v: unknown }).v;
}
