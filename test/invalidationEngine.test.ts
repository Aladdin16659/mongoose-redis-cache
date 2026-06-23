import { beforeEach, describe, expect, test } from "vitest";
import { InvalidationEngine } from "../src/invalidation/InvalidationEngine.js";
import { InMemoryDependencyIndex } from "../src/invalidation/DependencyIndex.js";
import type { Filter } from "../src/invalidation/PredicateMatcher.js";

let index: InMemoryDependencyIndex;
let engine: InvalidationEngine;

beforeEach(() => {
  index = new InMemoryDependencyIndex();
  engine = new InvalidationEngine(index);
});

async function register(
  queryKey: string,
  predicate: Filter,
  resultDocIds: string[],
  limited = false,
) {
  await engine.registerQuery("Product", queryKey, {
    predicate,
    limited,
    resultDocIds,
  });
}

describe("InvalidationEngine — direct membership", () => {
  test("updating a doc in a cached result set invalidates that query", async () => {
    await register("q:active", { status: "active" }, ["p1", "p2"]);

    const report = await engine.onWrite(
      "Product",
      { _id: "p1", status: "active", price: 10 },
      { _id: "p1", status: "active", price: 12 },
    );

    expect(report.invalidatedQueryKeys).toContain("q:active");
  });

  test("deleting a doc in a cached result set invalidates that query", async () => {
    await register("q:active", { status: "active" }, ["p1"]);

    const report = await engine.onWrite(
      "Product",
      { _id: "p1", status: "active" },
      null,
    );

    expect(report.invalidatedQueryKeys).toContain("q:active");
  });
});

describe("InvalidationEngine — membership transitions", () => {
  test("insert that newly matches a predicate invalidates the query (entering)", async () => {
    await register("q:active", { status: "active" }, ["p1"]);

    const report = await engine.onWrite("Product", null, {
      _id: "p9",
      status: "active",
    });

    expect(report.invalidatedQueryKeys).toContain("q:active");
  });

  test("update that makes a doc leave a predicate invalidates the query (leaving)", async () => {
    await register("q:active", { status: "active" }, ["p1"]);

    const report = await engine.onWrite(
      "Product",
      { _id: "p1", status: "active" },
      { _id: "p1", status: "archived" },
    );

    expect(report.invalidatedQueryKeys).toContain("q:active");
  });

  test("a write unrelated to the predicate and not in the set does NOT invalidate", async () => {
    await register("q:active", { status: "active" }, ["p1", "p2"]);

    const report = await engine.onWrite(
      "Product",
      { _id: "p9", status: "archived" },
      { _id: "p9", status: "draft" },
    );

    expect(report.invalidatedQueryKeys).not.toContain("q:active");
  });

  test("only the affected query among several is invalidated", async () => {
    await register("q:active", { status: "active" }, ["p1"]);
    await register("q:archived", { status: "archived" }, ["p5"]);

    const report = await engine.onWrite(
      "Product",
      { _id: "p1", status: "active" },
      { _id: "p1", status: "active", price: 99 },
    );

    expect(report.invalidatedQueryKeys).toEqual(["q:active"]);
  });
});

describe("InvalidationEngine — top-N (limited) safety", () => {
  test("a new matching doc invalidates a limited query even if not in the set", async () => {
    await register("q:top", { status: "active" }, ["p1", "p2"], true);

    const report = await engine.onWrite("Product", null, {
      _id: "p99",
      status: "active",
    });

    expect(report.invalidatedQueryKeys).toContain("q:top");
  });

  test("a non-matching write does not invalidate a limited query", async () => {
    await register("q:top", { status: "active" }, ["p1"], true);

    const report = await engine.onWrite("Product", null, {
      _id: "p99",
      status: "archived",
    });

    expect(report.invalidatedQueryKeys).not.toContain("q:top");
  });
});

describe("InvalidationEngine — registry cleanup", () => {
  test("an invalidated query is removed from the index", async () => {
    await register("q:active", { status: "active" }, ["p1"]);

    await engine.onWrite(
      "Product",
      { _id: "p1", status: "active" },
      { _id: "p1", status: "archived" },
    );

    expect(await index.getQueries("Product")).toEqual([]);
  });

  test("ObjectId-like ids compare by hex value, not reference", async () => {
    const idLike = (hex: string) => ({
      _bsontype: "ObjectId" as const,
      toHexString: () => hex,
    });
    await register("q:active", { status: "active" }, ["507f1f77bcf86cd799439011"]);

    const report = await engine.onWrite(
      "Product",
      { _id: idLike("507f1f77bcf86cd799439011"), status: "active" },
      { _id: idLike("507f1f77bcf86cd799439011"), status: "active", v: 2 },
    );

    expect(report.invalidatedQueryKeys).toContain("q:active");
  });
});
