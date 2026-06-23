import { describe, expect, test } from "vitest";
import { ObjectId } from "bson";
import { deserialize, serialize } from "../src/cache/Serializer.js";
import { buildDocKey, buildQueryKey } from "../src/cache/CacheKey.js";
import { classifyQuery } from "../src/invalidation/TierClassifier.js";

function rt(value: unknown): unknown {
  return deserialize(serialize(value));
}

describe("serializer — falsy and empty values", () => {
  test("undefined round-trips to undefined", () => {
    expect(rt(undefined)).toBeUndefined();
  });

  test("falsy primitives survive", () => {
    expect(rt(0)).toBe(0);
    expect(rt("")).toBe("");
    expect(rt(false)).toBe(false);
  });

  test("empty array and empty object", () => {
    expect(rt([])).toEqual([]);
    expect(rt({})).toEqual({});
  });

  test("array of ObjectIds preserves each element", () => {
    const ids = [
      new ObjectId("507f1f77bcf86cd799439011"),
      new ObjectId("507f1f77bcf86cd799439012"),
    ];
    const out = rt({ ids }) as { ids: ObjectId[] };
    expect(out.ids[0]).toBeInstanceOf(ObjectId);
    expect(out.ids.map((i) => i.toHexString())).toEqual([
      "507f1f77bcf86cd799439011",
      "507f1f77bcf86cd799439012",
    ]);
  });

  test("Date nested inside an array survives", () => {
    const out = rt([{ at: new Date("2020-01-01T00:00:00.000Z") }]) as {
      at: Date;
    }[];
    expect(out[0]!.at).toBeInstanceOf(Date);
  });
});

describe("cache key — distinguishing inputs", () => {
  const base = { model: "User", op: "find" as const, filter: { a: 1 } };

  test("populate, collation and schemaVersion each change the key", () => {
    const k0 = buildQueryKey(base);
    expect(buildQueryKey({ ...base, populate: "company" })).not.toBe(k0);
    expect(buildQueryKey({ ...base, collation: { locale: "en" } })).not.toBe(k0);
    expect(buildQueryKey({ ...base, schemaVersion: "v2" })).not.toBe(k0);
  });

  test("buildDocKey with and without tenant", () => {
    expect(buildDocKey("User", "1")).toBe("doc:User:1");
    expect(buildDocKey("User", "1", "t7")).toBe("tenant:t7:doc:User:1");
  });
});

describe("tier classifier — boundary shapes", () => {
  test("_id plus another field is not a point read (T1)", () => {
    expect(classifyQuery({ op: "find", filter: { _id: "x", status: "a" } })).toBe(
      "T1",
    );
  });

  test("_id with $ne is a predicate, not a point read (T1)", () => {
    expect(classifyQuery({ op: "find", filter: { _id: { $ne: "x" } } })).toBe(
      "T1",
    );
  });

  test("aggregate inside a session is still T4 (session wins)", () => {
    expect(classifyQuery({ op: "aggregate", hasSession: true })).toBe("T4");
  });

  test("distinct with an unsupported filter is T2", () => {
    expect(classifyQuery({ op: "distinct", filter: { $where: "x" } })).toBe("T2");
  });
});
