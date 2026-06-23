import { describe, expect, test } from "vitest";
import {
  isSupportedPredicate,
  matches,
} from "../src/invalidation/PredicateMatcher.js";

describe("matches — implicit equality", () => {
  test("scalar equality", () => {
    expect(matches({ status: "active" }, { status: "active" })).toBe(true);
    expect(matches({ status: "active" }, { status: "inactive" })).toBe(false);
  });

  test("missing field does not equal a concrete value", () => {
    expect(matches({ status: "active" }, {})).toBe(false);
  });

  test("multiple fields are an implicit AND", () => {
    expect(matches({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(matches({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false);
  });

  test("nested dot-path equality", () => {
    expect(matches({ "a.b": 1 }, { a: { b: 1 } })).toBe(true);
    expect(matches({ "a.b": 1 }, { a: { b: 2 } })).toBe(false);
    expect(matches({ "a.b": 1 }, { a: {} })).toBe(false);
  });

  test("equality matches when field is an array containing the value", () => {
    expect(matches({ tags: "x" }, { tags: ["x", "y"] })).toBe(true);
    expect(matches({ tags: "z" }, { tags: ["x", "y"] })).toBe(false);
  });

  test("equality to null matches null or missing field (Mongo semantics)", () => {
    expect(matches({ a: null }, { a: null })).toBe(true);
    expect(matches({ a: null }, {})).toBe(true);
    expect(matches({ a: null }, { a: 1 })).toBe(false);
  });
});

describe("matches — comparison operators", () => {
  test("$eq and $ne", () => {
    expect(matches({ a: { $eq: 1 } }, { a: 1 })).toBe(true);
    expect(matches({ a: { $ne: 1 } }, { a: 2 })).toBe(true);
    expect(matches({ a: { $ne: 1 } }, { a: 1 })).toBe(false);
  });

  test("$gt/$gte/$lt/$lte on numbers", () => {
    expect(matches({ a: { $gt: 5 } }, { a: 6 })).toBe(true);
    expect(matches({ a: { $gt: 5 } }, { a: 5 })).toBe(false);
    expect(matches({ a: { $gte: 5 } }, { a: 5 })).toBe(true);
    expect(matches({ a: { $lt: 5 } }, { a: 4 })).toBe(true);
    expect(matches({ a: { $lte: 5 } }, { a: 5 })).toBe(true);
  });

  test("comparisons work on Dates", () => {
    const doc = { at: new Date("2020-06-01") };
    expect(matches({ at: { $gt: new Date("2020-01-01") } }, doc)).toBe(true);
    expect(matches({ at: { $lt: new Date("2020-01-01") } }, doc)).toBe(false);
  });

  test("$in and $nin", () => {
    expect(matches({ a: { $in: [1, 2, 3] } }, { a: 2 })).toBe(true);
    expect(matches({ a: { $in: [1, 2, 3] } }, { a: 9 })).toBe(false);
    expect(matches({ a: { $nin: [1, 2] } }, { a: 9 })).toBe(true);
  });

  test("$in matches when an array field intersects the list", () => {
    expect(matches({ tags: { $in: ["x", "q"] } }, { tags: ["a", "x"] })).toBe(
      true,
    );
  });

  test("$exists", () => {
    expect(matches({ a: { $exists: true } }, { a: 1 })).toBe(true);
    expect(matches({ a: { $exists: true } }, {})).toBe(false);
    expect(matches({ a: { $exists: false } }, {})).toBe(true);
    expect(matches({ a: { $exists: false } }, { a: 1 })).toBe(false);
  });
});

describe("matches — logical operators", () => {
  test("$and", () => {
    expect(matches({ $and: [{ a: 1 }, { b: 2 }] }, { a: 1, b: 2 })).toBe(true);
    expect(matches({ $and: [{ a: 1 }, { b: 2 }] }, { a: 1, b: 9 })).toBe(false);
  });

  test("$or", () => {
    expect(matches({ $or: [{ a: 1 }, { b: 2 }] }, { a: 9, b: 2 })).toBe(true);
    expect(matches({ $or: [{ a: 1 }, { b: 2 }] }, { a: 9, b: 9 })).toBe(false);
  });

  test("$nor", () => {
    expect(matches({ $nor: [{ a: 1 }, { b: 2 }] }, { a: 9, b: 9 })).toBe(true);
    expect(matches({ $nor: [{ a: 1 }, { b: 2 }] }, { a: 1, b: 9 })).toBe(false);
  });

  test("$not wrapping an operator expression", () => {
    expect(matches({ a: { $not: { $gt: 5 } } }, { a: 3 })).toBe(true);
    expect(matches({ a: { $not: { $gt: 5 } } }, { a: 9 })).toBe(false);
  });
});

describe("isSupportedPredicate — the T1 boundary", () => {
  test("accepts equality and supported operator combinations", () => {
    expect(isSupportedPredicate({ a: 1 })).toBe(true);
    expect(isSupportedPredicate({ a: { $gt: 1, $lt: 10 } })).toBe(true);
    expect(isSupportedPredicate({ $or: [{ a: 1 }, { b: { $in: [1, 2] } }] })).toBe(
      true,
    );
    expect(isSupportedPredicate({ "a.b": 1, c: { $exists: true } })).toBe(true);
  });

  test("rejects $where", () => {
    expect(isSupportedPredicate({ $where: "this.a > 1" })).toBe(false);
  });

  test("rejects $text", () => {
    expect(isSupportedPredicate({ $text: { $search: "hi" } })).toBe(false);
  });

  test("rejects $regex and RegExp literals", () => {
    expect(isSupportedPredicate({ name: { $regex: "^a" } })).toBe(false);
    expect(isSupportedPredicate({ name: /^a/ })).toBe(false);
  });

  test("rejects $expr and geo operators", () => {
    expect(isSupportedPredicate({ $expr: { $gt: ["$a", 1] } })).toBe(false);
    expect(isSupportedPredicate({ loc: { $near: [0, 0] } })).toBe(false);
  });

  test("rejects unknown operators", () => {
    expect(isSupportedPredicate({ a: { $weird: 1 } })).toBe(false);
  });
});
