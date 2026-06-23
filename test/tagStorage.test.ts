import { afterEach, beforeEach, describe, expect, test } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { InMemoryCacheStore, type CacheStore } from "../src/cache/CacheStore.js";
import { RedisCacheStore } from "../src/cache/RedisCacheStore.js";
import {
  InMemoryDependencyIndex,
  type DependencyIndex,
} from "../src/invalidation/DependencyIndex.js";
import { RedisDependencyIndex } from "../src/invalidation/RedisDependencyIndex.js";

describe.each([
  ["InMemoryCacheStore", () => new InMemoryCacheStore(), null as Redis | null],
])("%s — tag sets", (_name, make) => {
  let store: CacheStore;
  beforeEach(() => {
    store = make();
  });

  test("addToSet then drainSet returns members and empties the set", async () => {
    await store.addToSet("tag:coll:products", "k1");
    await store.addToSet("tag:coll:products", "k2");

    const drained = await store.drainSet("tag:coll:products");
    expect(drained.sort()).toEqual(["k1", "k2"]);

    // Draining clears the set.
    expect(await store.drainSet("tag:coll:products")).toEqual([]);
  });

  test("drainSet on an unknown set is empty", async () => {
    expect(await store.drainSet("nope")).toEqual([]);
  });
});

describe("RedisCacheStore — tag sets", () => {
  let redis: Redis;
  let store: RedisCacheStore;
  beforeEach(() => {
    redis = new RedisMock() as unknown as Redis;
    store = new RedisCacheStore(redis);
  });
  afterEach(async () => {
    await redis.flushall();
    redis.disconnect();
  });

  test("addToSet then drainSet returns members and empties the set", async () => {
    await store.addToSet("tag:coll:products", "k1");
    await store.addToSet("tag:coll:products", "k2");
    const drained = await store.drainSet("tag:coll:products");
    expect(drained.sort()).toEqual(["k1", "k2"]);
    expect(await store.drainSet("tag:coll:products")).toEqual([]);
  });
});

describe.each([
  ["InMemoryDependencyIndex", () => new InMemoryDependencyIndex()],
])("%s — clearModel", (_name, make) => {
  let index: DependencyIndex;
  beforeEach(() => {
    index = make();
  });

  test("clearModel removes and returns all of a model's query keys", async () => {
    await index.addQuery("Product", "q1", {
      predicate: { a: 1 },
      limited: false,
      resultDocIds: [],
    });
    await index.addQuery("Product", "q2", {
      predicate: { b: 2 },
      limited: false,
      resultDocIds: [],
    });

    const cleared = await index.clearModel("Product");
    expect(cleared.sort()).toEqual(["q1", "q2"]);
    expect(await index.getQueries("Product")).toEqual([]);
  });
});

describe("RedisDependencyIndex — clearModel", () => {
  let redis: Redis;
  let index: RedisDependencyIndex;
  beforeEach(() => {
    redis = new RedisMock() as unknown as Redis;
    index = new RedisDependencyIndex(redis);
  });
  afterEach(async () => {
    await redis.flushall();
    redis.disconnect();
  });

  test("clearModel removes and returns all of a model's query keys", async () => {
    await index.addQuery("Product", "q1", {
      predicate: { a: 1 },
      limited: false,
      resultDocIds: [],
    });
    await index.addQuery("Product", "q2", {
      predicate: { b: 2 },
      limited: false,
      resultDocIds: [],
    });

    const cleared = await index.clearModel("Product");
    expect(cleared.sort()).toEqual(["q1", "q2"]);
    expect(await index.getQueries("Product")).toEqual([]);
  });
});
