import { afterEach, beforeEach, describe, expect, test } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { RedisCacheStore } from "../src/cache/RedisCacheStore.js";
import { serialize, deserialize } from "../src/cache/Serializer.js";

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

describe("RedisCacheStore — value round-trip", () => {
  test("get returns null for a missing key", async () => {
    expect(await store.get("missing")).toBeNull();
  });

  test("set then get round-trips binary BSON losslessly", async () => {
    const payload = serialize([{ _id: "p1", price: 9.99 }]);
    await store.set("k", payload);

    const out = await store.get("k");
    expect(out).not.toBeNull();
    expect(deserialize(out as Buffer)).toEqual([{ _id: "p1", price: 9.99 }]);
  });

  test("del removes keys", async () => {
    await store.set("a", serialize(1));
    await store.set("b", serialize(2));

    await store.del(["a", "b"]);

    expect(await store.get("a")).toBeNull();
    expect(await store.get("b")).toBeNull();
  });

  test("del tolerates an empty key list", async () => {
    await expect(store.del([])).resolves.toBeUndefined();
  });
});

describe("RedisCacheStore — version counter", () => {
  test("getVersion is 0 before any write", async () => {
    expect(await store.getVersion("Product")).toBe(0);
  });

  test("bumpVersion increments and getVersion reflects it", async () => {
    expect(await store.bumpVersion("Product")).toBe(1);
    expect(await store.bumpVersion("Product")).toBe(2);
    expect(await store.getVersion("Product")).toBe(2);
  });

  test("version counters are isolated per model", async () => {
    await store.bumpVersion("Product");
    expect(await store.getVersion("User")).toBe(0);
  });
});
