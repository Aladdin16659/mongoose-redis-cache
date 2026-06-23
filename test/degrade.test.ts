import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, test } from "vitest";
import { CacheManager, type CachedQuery } from "../src/cache/CacheManager.js";
import { InMemoryCacheStore, type CacheStore } from "../src/cache/CacheStore.js";
import { InvalidationEngine } from "../src/invalidation/InvalidationEngine.js";
import { InMemoryDependencyIndex } from "../src/invalidation/DependencyIndex.js";

/** A store whose chosen operations throw, simulating Redis being down. */
class FlakyStore implements CacheStore {
  private inner = new InMemoryCacheStore();
  constructor(private readonly failOn: Set<string>) {}
  async get(key: string) {
    if (this.failOn.has("get")) throw new Error("redis down");
    return this.inner.get(key);
  }
  async set(key: string, value: Buffer, ttlMs?: number) {
    if (this.failOn.has("set")) throw new Error("redis down");
    return this.inner.set(key, value, ttlMs);
  }
  async del(keys: string[]) {
    if (this.failOn.has("del")) throw new Error("redis down");
    return this.inner.del(keys);
  }
  async getVersion(model: string) {
    if (this.failOn.has("getVersion")) throw new Error("redis down");
    return this.inner.getVersion(model);
  }
  async bumpVersion(model: string) {
    if (this.failOn.has("bumpVersion")) throw new Error("redis down");
    return this.inner.bumpVersion(model);
  }
  async addToSet(setKey: string, member: string) {
    if (this.failOn.has("addToSet")) throw new Error("redis down");
    return this.inner.addToSet(setKey, member);
  }
  async drainSet(setKey: string) {
    if (this.failOn.has("drainSet")) throw new Error("redis down");
    return this.inner.drainSet(setKey);
  }
}

const query: CachedQuery = {
  key: "q:Product:active",
  model: "Product",
  tier: "T1",
  predicate: { status: "active" },
};

function makeManager(store: CacheStore, emitter?: EventEmitter) {
  const engine = new InvalidationEngine(new InMemoryDependencyIndex());
  return new CacheManager(store, engine, emitter);
}

describe("degrade-never-fail", () => {
  let calls: number;
  const loader = async () => {
    calls++;
    return [{ _id: "p1", status: "active" }];
  };
  const extract = (r: { _id: string }[]) => r.map((d) => d._id);

  beforeEach(() => {
    calls = 0;
  });

  test("get failure falls back to the loader instead of throwing", async () => {
    const manager = makeManager(new FlakyStore(new Set(["get"])));
    const result = await manager.getOrLoad(query, loader, extract);
    expect(result).toEqual([{ _id: "p1", status: "active" }]);
    expect(calls).toBe(1);
  });

  test("set failure still returns the loaded value", async () => {
    const manager = makeManager(new FlakyStore(new Set(["set"])));
    const result = await manager.getOrLoad(query, loader, extract);
    expect(result).toEqual([{ _id: "p1", status: "active" }]);
  });

  test("version-read failure does not throw and skips caching", async () => {
    const manager = makeManager(new FlakyStore(new Set(["getVersion"])));
    await manager.getOrLoad(query, loader, extract);
    await manager.getOrLoad(query, loader, extract);
    expect(calls).toBe(2); // never cached, so loader runs each time
  });

  test("does NOT crash when there is no 'error' listener attached", async () => {
    const emitter = new EventEmitter(); // no error listener
    const manager = makeManager(new FlakyStore(new Set(["get"])), emitter);
    await expect(manager.getOrLoad(query, loader, extract)).resolves.toEqual([
      { _id: "p1", status: "active" },
    ]);
  });

  test("emits an 'error' event when a listener is attached", async () => {
    const emitter = new EventEmitter();
    let errored = false;
    emitter.on("error", () => {
      errored = true;
    });
    const manager = makeManager(new FlakyStore(new Set(["get"])), emitter);
    await manager.getOrLoad(query, loader, extract);
    expect(errored).toBe(true);
  });

  test("onWrite does not throw when Redis is down (Mongo write already happened)", async () => {
    const manager = makeManager(
      new FlakyStore(new Set(["bumpVersion", "del", "getVersion"])),
    );
    await expect(
      manager.onWrite(
        "Product",
        { _id: "p1", status: "active" },
        { _id: "p1", status: "archived" },
      ),
    ).resolves.toBeDefined();
  });
});
