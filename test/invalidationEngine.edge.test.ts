import { beforeEach, describe, expect, test } from "vitest";
import { ObjectId } from "bson";
import { InvalidationEngine } from "../src/invalidation/InvalidationEngine.js";
import { InMemoryDependencyIndex } from "../src/invalidation/DependencyIndex.js";
import type { Filter } from "../src/invalidation/PredicateMatcher.js";

let index: InMemoryDependencyIndex;
let engine: InvalidationEngine;

beforeEach(() => {
  index = new InMemoryDependencyIndex();
  engine = new InvalidationEngine(index);
});

const reg = (key: string, predicate: Filter, ids: string[], limited = false) =>
  engine.registerQuery("Product", key, { predicate, limited, resultDocIds: ids });

describe("engine — replace and in-place updates", () => {
  test("in-place update of an in-set doc invalidates via direct membership", async () => {
    await reg("q:active", { status: "active" }, ["p1"]);
    const r = await engine.onWrite(
      "Product",
      { _id: "p1", status: "active", price: 1 },
      { _id: "p1", status: "active", price: 2 },
    );
    expect(r.invalidatedQueryKeys).toContain("q:active");
  });

  test("replace that keeps the doc out of every set invalidates nothing", async () => {
    await reg("q:active", { status: "active" }, ["p1"]);
    const r = await engine.onWrite(
      "Product",
      { _id: "p9", status: "archived" },
      { _id: "p9", status: "draft" },
    );
    expect(r.invalidatedQueryKeys).toEqual([]);
  });
});

describe("engine — multiple queries on one write", () => {
  test("a single write can invalidate several queries for different reasons", async () => {
    await reg("q:active", { status: "active" }, ["p1"]); // direct membership
    await reg("q:expensive", { price: { $gt: 100 } }, ["p2"]); // entering

    const r = await engine.onWrite(
      "Product",
      { _id: "p1", status: "active", price: 50 },
      { _id: "p1", status: "active", price: 200 },
    );

    expect(r.invalidatedQueryKeys).toEqual(
      expect.arrayContaining(["q:active", "q:expensive"]),
    );
  });

  test("queries not touched by the write are left intact in the index", async () => {
    await reg("q:active", { status: "active" }, ["p1"]);
    await reg("q:archived", { status: "archived" }, ["p5"]);

    await engine.onWrite(
      "Product",
      { _id: "p1", status: "active" },
      { _id: "p1", status: "active", v: 2 },
    );

    const remaining = (await index.getQueries("Product")).map((q) => q.queryKey);
    expect(remaining).toEqual(["q:archived"]);
  });
});

describe("engine — id typing", () => {
  test("ObjectId result ids match an ObjectId write document", async () => {
    const hex = "507f1f77bcf86cd799439011";
    await reg("q:active", { status: "active" }, [hex]);

    const r = await engine.onWrite(
      "Product",
      { _id: new ObjectId(hex), status: "active" },
      { _id: new ObjectId(hex), status: "active", v: 2 },
    );

    expect(r.invalidatedQueryKeys).toContain("q:active");
  });

  test("a no-op write (no before, no after) invalidates nothing", async () => {
    await reg("q:active", { status: "active" }, ["p1"]);
    const r = await engine.onWrite("Product", null, null);
    expect(r.invalidatedQueryKeys).toEqual([]);
  });
});
