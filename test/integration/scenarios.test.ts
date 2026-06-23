import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { createCache, type Cache } from "../../src/index.js";

let mongod: MongoMemoryServer;
let redis: Redis;
let cache: Cache;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Item: mongoose.Model<any>;

let tenantId: string | undefined;
const counts = { hit: 0, miss: 0, invalidate: 0 };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const schema = new mongoose.Schema({ name: String, status: String, price: Number });
  Item = mongoose.model("Item", schema);

  redis = new RedisMock() as unknown as Redis;
  cache = createCache({
    mongoose,
    redis,
    models: { Item: {} },
    tenant: () => tenantId,
  });
  cache.on("hit", () => counts.hit++);
  cache.on("miss", () => counts.miss++);
  cache.on("invalidate", () => counts.invalidate++);
}, 120_000);

afterAll(async () => {
  cache?.close();
  await mongoose.disconnect();
  await mongod?.stop();
  redis?.disconnect();
});

beforeEach(async () => {
  await Item.deleteMany({});
  await redis.flushall();
  tenantId = undefined;
  counts.hit = 0;
  counts.miss = 0;
  counts.invalidate = 0;
});

const activeCount = async () => (await Item.find({ status: "active" }).lean()).length;

describe("write paths invalidate precisely", () => {
  test("updateMany moving docs out of the set", async () => {
    await Item.insertMany([
      { name: "A", status: "active" },
      { name: "B", status: "active" },
      { name: "C", status: "active" },
    ]);
    expect(await activeCount()).toBe(3); // miss -> cache
    await Item.find({ status: "active" }).lean(); // hit

    await Item.updateMany({ status: "active" }, { status: "archived" });

    expect(await activeCount()).toBe(0);
  });

  test("deleteOne", async () => {
    await Item.insertMany([
      { name: "A", status: "active" },
      { name: "B", status: "active" },
    ]);
    expect(await activeCount()).toBe(2);

    await Item.deleteOne({ name: "A" });

    expect(await activeCount()).toBe(1);
  });

  test("deleteMany", async () => {
    await Item.insertMany([
      { name: "A", status: "active" },
      { name: "B", status: "active" },
    ]);
    expect(await activeCount()).toBe(2);

    await Item.deleteMany({ status: "active" });

    expect(await activeCount()).toBe(0);
  });

  test("document.save() update", async () => {
    await Item.create({ name: "A", status: "active" });
    expect(await activeCount()).toBe(1);

    const doc = await Item.findOne({ name: "A" });
    doc!.status = "archived";
    await doc!.save();

    expect(await activeCount()).toBe(0);
  });

  test("create() entering a cached set", async () => {
    await Item.create({ name: "A", status: "active" });
    expect(await activeCount()).toBe(1);
    await Item.find({ status: "active" }).lean(); // hit

    await Item.create({ name: "B", status: "active" });

    expect(await activeCount()).toBe(2);
  });

  test("insertMany entering a cached set", async () => {
    await Item.create({ name: "A", status: "active" });
    expect(await activeCount()).toBe(1);

    await Item.insertMany([{ name: "C", status: "active" }]);

    expect(await activeCount()).toBe(2);
  });

  test("replaceOne", async () => {
    await Item.create({ name: "A", status: "active" });
    expect(await activeCount()).toBe(1);

    await Item.replaceOne({ name: "A" }, { name: "A", status: "archived" });

    expect(await activeCount()).toBe(0);
  });
});

describe("countDocuments caching", () => {
  test("count is cached and invalidated when the set grows", async () => {
    await Item.create({ name: "A", status: "active" });

    expect(await Item.countDocuments({ status: "active" })).toBe(1); // miss
    expect(await Item.countDocuments({ status: "active" })).toBe(1); // hit
    expect(counts.hit).toBeGreaterThan(0);

    await Item.create({ name: "B", status: "active" });

    expect(await Item.countDocuments({ status: "active" })).toBe(2);
  });
});

describe("top-N (sort + limit) safety", () => {
  test("a new highest doc invalidates the cached top-1", async () => {
    await Item.insertMany([
      { name: "A", price: 10 },
      { name: "B", price: 20 },
    ]);
    const top1 = async () =>
      (await Item.find({}).sort({ price: -1 }).limit(1).lean()) as unknown as {
        price: number;
      }[];

    expect((await top1())[0]!.price).toBe(20); // miss -> cache
    await top1(); // hit

    await Item.create({ name: "C", price: 30 });

    expect((await top1())[0]!.price).toBe(30);
  });
});

describe("transaction/session reads bypass the cache (T4)", () => {
  test("queries bound to a session are never cached", async () => {
    await Item.create({ name: "A", status: "active" });
    const session = await mongoose.startSession();

    const before = counts.hit + counts.miss;
    await Item.find({ status: "active" }).session(session).lean();
    await Item.find({ status: "active" }).session(session).lean();
    const after = counts.hit + counts.miss;

    await session.endSession();
    expect(after).toBe(before); // no cache events => bypassed entirely
  });
});

describe("multi-tenant keyspace isolation", () => {
  test("the same query under a different tenant is a separate cache entry", async () => {
    await Item.create({ name: "A", status: "active" });

    tenantId = "t1";
    await Item.find({ status: "active" }).lean(); // miss (t1)
    await Item.find({ status: "active" }).lean(); // hit (t1)
    const missesAfterT1 = counts.miss;

    tenantId = "t2";
    await Item.find({ status: "active" }).lean(); // miss (t2 — isolated key)

    expect(counts.miss).toBe(missesAfterT1 + 1);
  });
});

describe("pagination produces distinct cache entries", () => {
  test("different skip/limit are cached independently", async () => {
    await Item.insertMany([
      { name: "A", price: 1 },
      { name: "B", price: 2 },
      { name: "C", price: 3 },
      { name: "D", price: 4 },
    ]);

    await Item.find({}).sort({ price: 1 }).skip(0).limit(2).lean(); // miss
    await Item.find({}).sort({ price: 1 }).skip(2).limit(2).lean(); // miss (distinct)

    expect(counts.miss).toBe(2);
    expect(counts.hit).toBe(0);
  });
});
