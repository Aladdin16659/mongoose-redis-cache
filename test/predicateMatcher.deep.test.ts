import { describe, expect, test } from "vitest";
import { isSupportedPredicate, matches } from "../src/invalidation/PredicateMatcher.js";

describe("matches — deeply nested logical trees", () => {
  const filter = {
    $and: [
      { status: "active" },
      {
        $or: [
          { price: { $gte: 10, $lte: 100 } },
          { $nor: [{ category: "a" }, { category: "b" }] },
        ],
      },
      { tags: { $in: ["x", "y"] } },
      { qty: { $not: { $lt: 5 } } },
    ],
  };

  test("a document satisfying every branch matches", () => {
    expect(
      matches(filter, {
        status: "active",
        price: 50,
        category: "z",
        tags: ["x"],
        qty: 9,
      }),
    ).toBe(true);
  });

  test("failing the $and on status fails the whole tree", () => {
    expect(
      matches(filter, {
        status: "archived",
        price: 50,
        tags: ["x"],
        qty: 9,
      }),
    ).toBe(false);
  });

  test("the $or is satisfied via the $nor branch when price is out of range", () => {
    expect(
      matches(filter, {
        status: "active",
        price: 9999,
        category: "c", // not a/b → $nor true
        tags: ["y"],
        qty: 7,
      }),
    ).toBe(true);
  });

  test("$not negates the nested range correctly", () => {
    expect(
      matches(filter, {
        status: "active",
        price: 50,
        tags: ["x"],
        qty: 3, // qty < 5 → $not fails
      }),
    ).toBe(false);
  });

  test("the whole nested tree is a supported predicate", () => {
    expect(isSupportedPredicate(filter)).toBe(true);
  });

  test("one unsupported leaf anywhere poisons the whole tree", () => {
    const poisoned = {
      $and: [{ status: "active" }, { $or: [{ name: { $regex: "^a" } }] }],
    };
    expect(isSupportedPredicate(poisoned)).toBe(false);
  });
});
