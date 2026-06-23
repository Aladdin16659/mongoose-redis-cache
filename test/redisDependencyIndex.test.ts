import { afterEach, beforeEach, describe, expect, test } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { ObjectId } from "bson";
import { RedisDependencyIndex } from "../src/invalidation/RedisDependencyIndex.js";

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

describe("RedisDependencyIndex", () => {
  test("getQueries is empty for an unknown model", async () => {
    expect(await index.getQueries("Product")).toEqual([]);
  });

  test("addQuery then getQueries returns the registered query", async () => {
    await index.addQuery("Product", "q1", {
      predicate: { status: "active" },
      limited: false,
      resultDocIds: ["p1", "p2"],
    });

    const queries = await index.getQueries("Product");
    expect(queries).toEqual([
      {
        queryKey: "q1",
        predicate: { status: "active" },
        limited: false,
        resultDocIds: ["p1", "p2"],
      },
    ]);
  });

  test("removeQuery drops it from the registry", async () => {
    await index.addQuery("Product", "q1", {
      predicate: { a: 1 },
      limited: false,
      resultDocIds: [],
    });
    await index.removeQuery("Product", "q1");

    expect(await index.getQueries("Product")).toEqual([]);
  });

  test("registry is isolated per model", async () => {
    await index.addQuery("Product", "q1", {
      predicate: { a: 1 },
      limited: false,
      resultDocIds: [],
    });
    expect(await index.getQueries("User")).toEqual([]);
  });

  test("predicates containing ObjectId/Date survive the round-trip (BSON)", async () => {
    const id = new ObjectId("507f1f77bcf86cd799439011");
    const since = new Date("2020-01-01T00:00:00.000Z");
    await index.addQuery("Product", "q1", {
      predicate: { owner: id, createdAt: { $gt: since } },
      limited: false,
      resultDocIds: [],
    });

    const [q] = await index.getQueries("Product");
    const pred = q!.predicate as { owner: ObjectId; createdAt: { $gt: Date } };
    expect(pred.owner).toBeInstanceOf(ObjectId);
    expect(pred.owner.toHexString()).toBe("507f1f77bcf86cd799439011");
    expect(pred.createdAt.$gt).toBeInstanceOf(Date);
    expect(pred.createdAt.$gt.getTime()).toBe(since.getTime());
  });

  test("registry persists across instances (restart safety)", async () => {
    await index.addQuery("Product", "q1", {
      predicate: { a: 1 },
      limited: true,
      resultDocIds: ["p1"],
    });

    // A fresh index over the same Redis (simulating a process restart) still
    // sees the registered query, so writes can still invalidate it.
    const reopened = new RedisDependencyIndex(redis);
    const queries = await reopened.getQueries("Product");
    expect(queries).toHaveLength(1);
    expect(queries[0]!.queryKey).toBe("q1");
    expect(queries[0]!.limited).toBe(true);
  });
});
