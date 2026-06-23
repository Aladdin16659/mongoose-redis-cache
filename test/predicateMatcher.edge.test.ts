import { describe, expect, test } from "vitest";
import { ObjectId } from "bson";
import {
  isSupportedPredicate,
  matches,
} from "../src/invalidation/PredicateMatcher.js";

describe("matches — null/missing nuances", () => {
  test("$ne to a value matches a missing field (Mongo semantics)", () => {
    expect(matches({ a: { $ne: 5 } }, {})).toBe(true);
  });

  test("$ne null does not match a missing field", () => {
    expect(matches({ a: { $ne: null } }, {})).toBe(false);
    expect(matches({ a: { $ne: null } }, { a: 1 })).toBe(true);
  });

  test("$exists on a nested path", () => {
    expect(matches({ "a.b": { $exists: true } }, { a: { b: 1 } })).toBe(true);
    expect(matches({ "a.b": { $exists: true } }, { a: {} })).toBe(false);
  });
});

describe("matches — arrays and whole-value equality", () => {
  test("equality to a whole array value", () => {
    expect(matches({ tags: ["x", "y"] }, { tags: ["x", "y"] })).toBe(true);
    expect(matches({ tags: ["x", "y"] }, { tags: ["x"] })).toBe(false);
  });

  test("$gt matches when any array element satisfies", () => {
    expect(matches({ scores: { $gt: 90 } }, { scores: [10, 95] })).toBe(true);
    expect(matches({ scores: { $gt: 90 } }, { scores: [10, 20] })).toBe(false);
  });

  test("$nin excludes when an array field intersects the list", () => {
    expect(matches({ tags: { $nin: ["x"] } }, { tags: ["x", "y"] })).toBe(false);
    expect(matches({ tags: { $nin: ["z"] } }, { tags: ["x", "y"] })).toBe(true);
  });
});

describe("matches — operator composition", () => {
  test("$not wrapping $in", () => {
    expect(matches({ a: { $not: { $in: [1, 2] } } }, { a: 3 })).toBe(true);
    expect(matches({ a: { $not: { $in: [1, 2] } } }, { a: 1 })).toBe(false);
  });

  test("range via combined $gte/$lte on one field", () => {
    expect(matches({ a: { $gte: 5, $lte: 10 } }, { a: 7 })).toBe(true);
    expect(matches({ a: { $gte: 5, $lte: 10 } }, { a: 11 })).toBe(false);
  });

  test("$or nested inside $and", () => {
    const f = { $and: [{ a: 1 }, { $or: [{ b: 2 }, { c: 3 }] }] };
    expect(matches(f, { a: 1, c: 3 })).toBe(true);
    expect(matches(f, { a: 1, b: 9, c: 9 })).toBe(false);
  });

  test("equality against ObjectId by value", () => {
    const id = new ObjectId("507f1f77bcf86cd799439011");
    expect(
      matches(
        { owner: id },
        { owner: new ObjectId("507f1f77bcf86cd799439011") },
      ),
    ).toBe(true);
  });
});

describe("isSupportedPredicate — soundness boundary hardening", () => {
  test("rejects a RegExp inside $in (would be matched as equality, not pattern)", () => {
    expect(isSupportedPredicate({ name: { $in: [/^a/] } })).toBe(false);
  });

  test("rejects a RegExp inside $nin", () => {
    expect(isSupportedPredicate({ name: { $nin: ["a", /b/] } })).toBe(false);
  });

  test("accepts plain values inside $in", () => {
    expect(isSupportedPredicate({ name: { $in: ["a", "b"] } })).toBe(true);
  });

  test("rejects $not wrapping a non-operator (regex)", () => {
    expect(isSupportedPredicate({ name: { $not: /a/ } })).toBe(false);
  });

  test("accepts deeply nested supported logical trees", () => {
    expect(
      isSupportedPredicate({
        $and: [{ a: { $gt: 1 } }, { $or: [{ b: { $in: [1] } }, { c: 2 }] }],
      }),
    ).toBe(true);
  });
});
