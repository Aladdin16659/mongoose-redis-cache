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
let Product: mongoose.Model<any>;

const counts = { hit: 0, miss: 0, invalidate: 0 };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const schema = new mongoose.Schema({
    name: String,
    status: String,
    price: Number,
  });
  Product = mongoose.model("Product", schema);

  redis = new RedisMock() as unknown as Redis;
  cache = createCache({ mongoose, redis, models: { Product: {} } });
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
  await Product.deleteMany({});
  await redis.flushall();
  counts.hit = 0;
  counts.miss = 0;
  counts.invalidate = 0;
});

describe("end-to-end caching", () => {
  test("identical lean queries hit the cache on the second call", async () => {
    await Product.create({ name: "A", status: "active", price: 10 });

    const r1 = await Product.find({ status: "active" }).lean();
    const r2 = await Product.find({ status: "active" }).lean();

    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(counts.miss).toBe(1);
    expect(counts.hit).toBe(1);
  });

  test("a write that moves a doc INTO the result set invalidates and reloads", async () => {
    await Product.create({ name: "A", status: "active", price: 10 });
    await Product.create({ name: "B", status: "inactive", price: 20 });

    const before = await Product.find({ status: "active" }).lean();
    expect(before).toHaveLength(1);
    await Product.find({ status: "active" }).lean(); // hit

    // B enters the "active" set — must invalidate the cached query.
    await Product.findOneAndUpdate({ name: "B" }, { status: "active" });

    const after = await Product.find({ status: "active" }).lean();
    expect(after).toHaveLength(2);
    expect(counts.invalidate).toBeGreaterThan(0);
  });

  test("an unrelated write does NOT invalidate the cached query", async () => {
    await Product.create({ name: "A", status: "active", price: 10 });
    await Product.create({ name: "B", status: "archived", price: 20 });

    await Product.find({ status: "active" }).lean(); // miss
    await Product.find({ status: "active" }).lean(); // hit
    const invalidatesBefore = counts.invalidate;

    // Update B (archived -> draft): never in or entering the active set.
    await Product.findOneAndUpdate({ name: "B" }, { status: "draft" });

    const again = await Product.find({ status: "active" }).lean();
    expect(again).toHaveLength(1);
    expect(counts.invalidate).toBe(invalidatesBefore);
  });

  test("point read by id is cached and invalidated on update", async () => {
    const doc = await Product.create({ name: "A", status: "active", price: 10 });

    const a = (await Product.findById(doc._id).lean()) as { name: string } | null;
    expect(a?.name).toBe("A");
    await Product.findById(doc._id).lean(); // hit

    await Product.findOneAndUpdate({ _id: doc._id }, { name: "A2" });

    const b = (await Product.findById(doc._id).lean()) as { name: string } | null;
    expect(b?.name).toBe("A2");
  });

  test("non-lean queries return hydrated Mongoose documents", async () => {
    await Product.create({ name: "A", status: "active", price: 10 });

    await Product.find({ status: "active" }); // miss, caches plain form
    const hydrated = await Product.find({ status: "active" }); // hit

    expect(hydrated[0]).toBeInstanceOf(mongoose.Document);
    expect(hydrated[0]!.name).toBe("A");
  });
});
