import { describe, expect, test } from "vitest";
import { ObjectId } from "bson";
import { normalizeQuery } from "../src/cache/fingerprint.js";

describe("normalizeQuery", () => {
  test("orders object keys deterministically regardless of insertion order", () => {
    const a = normalizeQuery({ a: 1, b: 2 });
    const b = normalizeQuery({ b: 2, a: 1 });

    expect(a).toEqual(b);
    expect(Object.keys(a as object)).toEqual(["a", "b"]);
  });

  test("normalizes nested objects recursively", () => {
    const a = normalizeQuery({ filter: { z: 1, a: { y: 2, x: 1 } } });
    const b = normalizeQuery({ filter: { a: { x: 1, y: 2 }, z: 1 } });

    expect(a).toEqual(b);
  });

  test("preserves array order (arrays are ordered semantically)", () => {
    expect(normalizeQuery([3, 1, 2])).toEqual([3, 1, 2]);
  });

  test("normalizes ObjectId to a stable tagged form", () => {
    const id = new ObjectId("507f1f77bcf86cd799439011");
    expect(normalizeQuery(id)).toEqual({ $oid: "507f1f77bcf86cd799439011" });
  });

  test("two distinct ObjectIds with same hex normalize equal", () => {
    const a = normalizeQuery({ _id: new ObjectId("507f1f77bcf86cd799439011") });
    const b = normalizeQuery({ _id: new ObjectId("507f1f77bcf86cd799439011") });
    expect(a).toEqual(b);
  });

  test("normalizes Date to a stable tagged form", () => {
    const d = new Date("2020-01-01T00:00:00.000Z");
    expect(normalizeQuery(d)).toEqual({ $date: "2020-01-01T00:00:00.000Z" });
  });

  test("normalizes RegExp to source + flags", () => {
    expect(normalizeQuery(/abc/i)).toEqual({ $regex: "abc", $options: "i" });
  });

  test("passes through primitives unchanged", () => {
    expect(normalizeQuery(5)).toBe(5);
    expect(normalizeQuery("x")).toBe("x");
    expect(normalizeQuery(true)).toBe(true);
    expect(normalizeQuery(null)).toBe(null);
  });
});
