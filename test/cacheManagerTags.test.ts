import { beforeEach, describe, expect, test } from "vitest";
import { CacheManager, type CachedQuery } from "../src/cache/CacheManager.js";
import { InMemoryCacheStore } from "../src/cache/CacheStore.js";
import { InvalidationEngine } from "../src/invalidation/InvalidationEngine.js";
import { InMemoryDependencyIndex } from "../src/invalidation/DependencyIndex.js";

let store: InMemoryCacheStore;
let index: InMemoryDependencyIndex;
let manager: CacheManager;

beforeEach(() => {
  store = new InMemoryCacheStore();
  index = new InMemoryDependencyIndex();
  manager = new CacheManager(store, new InvalidationEngine(index));
});

const aggQuery: CachedQuery = {
  key: "agg:Product:abc",
  model: "Product",
  tier: "T3",
  tags: ["products"],
};

describe("conservative (tag-based) caching", () => {
  test("a tagged entry is cached and reused", async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      return [{ total: 5 }];
    };
    await manager.getOrLoad(aggQuery, loader);
    await manager.getOrLoad(aggQuery, loader);
    expect(calls).toBe(1);
  });

  test("invalidateCollection drains the tag and deletes tagged entries", async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      return [{ total: 5 }];
    };
    await manager.getOrLoad(aggQuery, loader); // cache + tag
    await manager.getOrLoad(aggQuery, loader); // hit
    expect(calls).toBe(1);

    const deleted = await manager.invalidateCollection("products");
    expect(deleted).toContain(aggQuery.key);

    await manager.getOrLoad(aggQuery, loader); // miss -> reload
    expect(calls).toBe(2);
  });

  test("invalidateCollection on an untouched collection deletes nothing", async () => {
    await manager.getOrLoad(aggQuery, async () => [{ total: 5 }]);
    const deleted = await manager.invalidateCollection("categories");
    expect(deleted).toEqual([]);
  });

  test("an entry tagged with multiple collections is invalidated by any of them", async () => {
    const joined: CachedQuery = {
      key: "agg:Order:join",
      model: "Order",
      tier: "T3",
      tags: ["orders", "products"],
    };
    let calls = 0;
    await manager.getOrLoad(joined, async () => {
      calls++;
      return [{ x: 1 }];
    });

    // A write to the looked-up "products" collection must invalidate it.
    await manager.invalidateCollection("products");
    await manager.getOrLoad(joined, async () => {
      calls++;
      return [{ x: 1 }];
    });
    expect(calls).toBe(2);
  });
});

describe("flushModelPrecise", () => {
  test("clears all registered T1 queries for a model and deletes their keys", async () => {
    const q: CachedQuery = {
      key: "q:Product:active",
      model: "Product",
      tier: "T1",
      predicate: { status: "active" },
    };
    await manager.getOrLoad(q, async () => [{ _id: "p1", status: "active" }], (r) =>
      r.map((d) => d._id),
    );
    expect(await index.getQueries("Product")).toHaveLength(1);

    const deleted = await manager.flushModelPrecise("Product");
    expect(deleted).toContain(q.key);
    expect(await index.getQueries("Product")).toEqual([]);
    expect(await store.get(q.key)).toBeNull();
  });
});
