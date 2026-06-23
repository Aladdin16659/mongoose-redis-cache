import { describe, expect, test } from "vitest";
import { Decimal128, ObjectId } from "bson";
import { deserialize, serialize } from "../src/cache/Serializer.js";

function roundTrip(value: unknown): unknown {
  return deserialize(serialize(value));
}

describe("serializer round-trip", () => {
  test("plain object", () => {
    expect(roundTrip({ name: "Ada", age: 36 })).toEqual({ name: "Ada", age: 36 });
  });

  test("nested object", () => {
    const v = { a: { b: { c: [1, 2, 3] } } };
    expect(roundTrip(v)).toEqual(v);
  });

  test("array of documents (query result shape)", () => {
    const v = [{ a: 1 }, { a: 2 }];
    expect(roundTrip(v)).toEqual(v);
  });

  test("number (count result)", () => {
    expect(roundTrip(42)).toBe(42);
  });

  test("null", () => {
    expect(roundTrip(null)).toBe(null);
  });

  test("preserves ObjectId type and value", () => {
    const id = new ObjectId("507f1f77bcf86cd799439011");
    const out = roundTrip({ _id: id }) as { _id: ObjectId };
    expect(out._id).toBeInstanceOf(ObjectId);
    expect(out._id.toHexString()).toBe("507f1f77bcf86cd799439011");
  });

  test("preserves Date type and value", () => {
    const d = new Date("2020-01-01T00:00:00.000Z");
    const out = roundTrip({ at: d }) as { at: Date };
    expect(out.at).toBeInstanceOf(Date);
    expect(out.at.getTime()).toBe(d.getTime());
  });

  test("preserves Decimal128", () => {
    const out = roundTrip({ price: Decimal128.fromString("9.99") }) as {
      price: Decimal128;
    };
    expect(out.price.toString()).toBe("9.99");
  });

  test("preserves Buffer/binary data", () => {
    const buf = Buffer.from([1, 2, 3, 4]);
    const out = roundTrip({ blob: buf }) as { blob: Buffer };
    expect(Buffer.isBuffer(out.blob)).toBe(true);
    expect(out.blob.equals(buf)).toBe(true);
  });

  test("serialize produces a Buffer", () => {
    expect(Buffer.isBuffer(serialize({ a: 1 }))).toBe(true);
  });
});
