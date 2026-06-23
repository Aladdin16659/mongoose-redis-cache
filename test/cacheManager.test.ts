import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, test } from "vitest";
import { CacheManager, type CachedQuery } from "../src/cache/CacheManager.js";
import { InMemoryCacheStore } from "../src/cache/CacheStore.js";
import { InvalidationEngine } from "../src/invalidation/InvalidationEngine.js";
import { InMemoryDependencyIndex } from "../src/invalidation/DependencyIndex.js";

let store: InMemoryCacheStore;
let engine: InvalidationEngine;
let manager: CacheManager;

beforeEach(() => {
  store = new InMemoryCacheStore();
  engine = new InvalidationEngine(new InMemoryDependencyIndex());
  manager = new CacheManager(store, engine);
});

const activeQuery: CachedQuery = {
  key: "q:Product:active",
  model: "Product",
  tier: "T1",
  predicate: { status: "active" },
};

describe("getOrLoad — basic caching", () => {
  test("first call loads, second call hits cache (loader runs once)", async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      return [{ _id: "p1", status: "active" }];
    };

    const a = await manager.getOrLoad(activeQuery, loader, (r) =>
      r.map((d) => d._id),
    );
    const b = await manager.getOrLoad(activeQuery, loader, (r) =>
      r.map((d) => d._id),
    );

    expect(a).toEqual(b);
    expect(calls).toBe(1);
  });

  test("T4 queries are never cached (loader runs every time)", async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      return [{ _id: "p1" }];
    };
    const q: CachedQuery = { key: "k", model: "Product", tier: "T4" };

    await manager.getOrLoad(q, loader);
    await manager.getOrLoad(q, loader);

    expect(calls).toBe(2);
  });

  test("concurrent misses for the same key collapse to a single load", async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return [{ _id: "p1", status: "active" }];
    };

    await Promise.all([
      manager.getOrLoad(activeQuery, loader, (r) => r.map((d) => d._id)),
      manager.getOrLoad(activeQuery, loader, (r) => r.map((d) => d._id)),
      manager.getOrLoad(activeQuery, loader, (r) => r.map((d) => d._id)),
    ]);

    expect(calls).toBe(1);
  });
});

describe("getOrLoad + onWrite — precise invalidation end to end", () => {
  test("a write that changes membership invalidates, forcing a reload", async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      return [{ _id: "p1", status: "active" }];
    };
    const extract = (r: { _id: string }[]) => r.map((d) => d._id);

    await manager.getOrLoad(activeQuery, loader, extract); // miss -> cache
    await manager.getOrLoad(activeQuery, loader, extract); // hit
    expect(calls).toBe(1);

    // p1 leaves the "active" set.
    await manager.onWrite(
      "Product",
      { _id: "p1", status: "active" },
      { _id: "p1", status: "archived" },
    );

    await manager.getOrLoad(activeQuery, loader, extract); // miss -> reload
    expect(calls).toBe(2);
  });

  test("an unrelated write does not cause a reload", async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      return [{ _id: "p1", status: "active" }];
    };
    const extract = (r: { _id: string }[]) => r.map((d) => d._id);

    await manager.getOrLoad(activeQuery, loader, extract);

    await manager.onWrite(
      "Product",
      { _id: "p9", status: "archived" },
      { _id: "p9", status: "draft" },
    );

    await manager.getOrLoad(activeQuery, loader, extract); // still a hit
    expect(calls).toBe(1);
  });
});

describe("getOrLoad — version-token race guard (no stale reads)", () => {
  test("a write during the load prevents caching the stale value", async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      // Simulate a concurrent committed write landing mid-load.
      await manager.onWrite(
        "Product",
        { _id: "p1", status: "active" },
        { _id: "p1", status: "archived" },
      );
      return [{ _id: "p1", status: "active" }]; // now-stale snapshot
    };
    const extract = (r: { _id: string }[]) => r.map((d) => d._id);

    await manager.getOrLoad(activeQuery, loader, extract);
    // Because the version changed mid-load, the stale value was NOT cached:
    await manager.getOrLoad(activeQuery, loader, extract);

    expect(calls).toBe(2);
  });
});

describe("events", () => {
  test("emits miss on load and hit on a cached read", async () => {
    const emitter = new EventEmitter();
    const seen: string[] = [];
    emitter.on("miss", () => seen.push("miss"));
    emitter.on("hit", () => seen.push("hit"));
    const m = new CacheManager(store, engine, emitter);
    const loader = async () => [{ _id: "p1", status: "active" }];
    const extract = (r: { _id: string }[]) => r.map((d) => d._id);

    await m.getOrLoad(activeQuery, loader, extract); // miss
    await m.getOrLoad(activeQuery, loader, extract); // hit

    expect(seen).toEqual(["miss", "hit"]);
  });

  test("emits invalidate with the deleted keys on a write", async () => {
    const emitter = new EventEmitter();
    let invalidated: string[] = [];
    emitter.on("invalidate", (info: { keys: string[] }) => {
      invalidated = info.keys;
    });
    const m = new CacheManager(store, engine, emitter);
    const extract = (r: { _id: string }[]) => r.map((d) => d._id);

    await m.getOrLoad(activeQuery, async () => [{ _id: "p1", status: "active" }], extract);
    await m.onWrite(
      "Product",
      { _id: "p1", status: "active" },
      { _id: "p1", status: "archived" },
    );

    expect(invalidated).toContain(activeQuery.key);
  });
});

describe("onWrite — extra keys", () => {
  test("explicit extra keys (e.g. the doc key) are deleted too", async () => {
    await store.set("doc:Product:p1", Buffer.from("x"));

    const deleted = await manager.onWrite("Product", null, { _id: "p1" }, [
      "doc:Product:p1",
    ]);

    expect(deleted).toContain("doc:Product:p1");
    expect(await store.get("doc:Product:p1")).toBeNull();
  });
});
