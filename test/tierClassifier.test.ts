import { describe, expect, test } from "vitest";
import { classifyQuery } from "../src/invalidation/TierClassifier.js";

describe("classifyQuery", () => {
  test("aggregate is T3", () => {
    expect(classifyQuery({ op: "aggregate" })).toBe("T3");
  });

  test("active session/transaction forces T4, even for a point read", () => {
    expect(classifyQuery({ op: "findById", hasSession: true })).toBe("T4");
  });

  test("cursor/streaming forces T4", () => {
    expect(classifyQuery({ op: "find", filter: { a: 1 }, isCursor: true })).toBe(
      "T4",
    );
  });

  test("findById is a point read (T0)", () => {
    expect(classifyQuery({ op: "findById" })).toBe("T0");
  });

  test("find/findOne by _id scalar is T0", () => {
    expect(classifyQuery({ op: "find", filter: { _id: "abc" } })).toBe("T0");
    expect(classifyQuery({ op: "findOne", filter: { _id: "abc" } })).toBe("T0");
  });

  test("find by _id $in is T0 (batch of point reads)", () => {
    expect(classifyQuery({ op: "find", filter: { _id: { $in: ["a", "b"] } } })).toBe(
      "T0",
    );
  });

  test("supported predicate query is T1", () => {
    expect(classifyQuery({ op: "find", filter: { status: "active" } })).toBe("T1");
    expect(classifyQuery({ op: "count", filter: { age: { $gt: 18 } } })).toBe("T1");
  });

  test("supported predicate with a limit stays T1", () => {
    // The invalidation engine applies conservative top-N handling within T1.
    expect(classifyQuery({ op: "find", filter: { status: "active" } })).toBe("T1");
  });

  test("a range on _id is a predicate, not a point read (T1)", () => {
    expect(classifyQuery({ op: "find", filter: { _id: { $gt: "m" } } })).toBe("T1");
  });

  test("unsupported predicate ($where, $regex, $text) is T2", () => {
    expect(classifyQuery({ op: "find", filter: { $where: "x" } })).toBe("T2");
    expect(classifyQuery({ op: "find", filter: { name: { $regex: "^a" } } })).toBe(
      "T2",
    );
    expect(classifyQuery({ op: "find", filter: { $text: { $search: "x" } } })).toBe(
      "T2",
    );
  });

  test("empty filter (match-all) is a supported predicate (T1)", () => {
    expect(classifyQuery({ op: "find", filter: {} })).toBe("T1");
  });

  test("estimatedDocumentCount is collection metadata (T2)", () => {
    expect(classifyQuery({ op: "estimatedDocumentCount" })).toBe("T2");
  });
});
