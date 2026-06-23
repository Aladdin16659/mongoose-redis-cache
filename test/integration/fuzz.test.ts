import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { Types } from "mongoose";
import { createCache, type Cache } from "../../src/index.js";

/**
 * Differential fuzzer: drive random write/read sequences through the cache and
 * assert that every cached read equals the result of the SAME query run
 * un-cached (the oracle). Any divergence is a stale-data bug.
 *
 * `Product` is registered with the cache; `Oracle` is an unregistered model on
 * the SAME collection, so its reads bypass caching entirely.
 */

let mongod: MongoMemoryServer;
let redis: Redis;
let cache: Cache;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Product: mongoose.Model<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Oracle: mongoose.Model<any>;

// Deterministic PRNG (mulberry32) so any failure is reproducible from the seed.
function makeRng(seed: number) {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUSES = ["active", "archived", "draft"];
const CATEGORIES = ["a", "b", "c"];
const TAGS = ["x", "y", "z"];

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const schema = new mongoose.Schema({
    status: String,
    price: Number,
    qty: Number,
    category: String,
    tags: [String],
  });
  Product = mongoose.model("Product", schema);
  // Same collection, unregistered → uncached oracle.
  Oracle = mongoose.model("Oracle", schema, Product.collection.collectionName);

  redis = new RedisMock() as unknown as Redis;
  cache = createCache({ mongoose, redis, models: { Product: {} } });
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
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalize(docs: any): unknown {
  const arr = Array.isArray(docs) ? docs : docs === null ? [] : [docs];
  return arr
    .map((d) => ({
      _id: String(d._id),
      status: d.status ?? null,
      price: d.price ?? null,
      qty: d.qty ?? null,
      category: d.category ?? null,
      tags: [...(d.tags ?? [])].sort(),
    }))
    .sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
}

async function runFuzz(seed: number, iterations: number): Promise<number> {
  await Product.deleteMany({});
  await redis.flushall();

  const rng = makeRng(seed);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;
  const int = (n: number) => Math.floor(rng() * n);
  const subset = <T>(arr: T[]): T[] => arr.filter(() => rng() < 0.5);

  const randDoc = () => ({
    status: pick(STATUSES),
    price: int(50),
    qty: int(10),
    category: pick(CATEGORIES),
    tags: subset(TAGS),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const randPredicate = (): Record<string, any> => {
    switch (int(9)) {
      case 0:
        return { status: pick(STATUSES) };
      case 1:
        return { price: { $gt: int(50) } };
      case 2:
        return { price: { $lte: int(50) } };
      case 3:
        return { category: { $in: subset(CATEGORIES) } };
      case 4:
        return { qty: { $gte: int(10) } };
      case 5:
        return { status: pick(STATUSES), price: { $lt: int(50) } };
      case 6:
        return { $or: [{ status: pick(STATUSES) }, { category: pick(CATEGORIES) }] };
      case 7:
        return { tags: pick(TAGS) }; // array-contains
      default:
        return {};
    }
  };

  const ids = async (): Promise<Types.ObjectId[]> =>
    (await Oracle.find({}).distinct("_id")) as Types.ObjectId[];

  const log: string[] = [];
  const fail = (label: string, c: string, o: string): never => {
    throw new Error(
      `STALE READ on "${label}" (seed=${seed})\ncached: ${c}\noracle: ${o}\n` +
        `recent ops:\n${log.slice(-30).join("\n")}`,
    );
  };
  const compare = async (
    label: string,
    run: (m: typeof Product) => Promise<unknown>,
    ordered = false,
  ) => {
    const cached = await run(Product);
    const oracle = await run(Oracle);
    log.push(label);
    const proj = ordered
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? (xs: any) => JSON.stringify((xs as any[]).map((d) => [String(d._id), d.price]))
      : (xs: unknown) => JSON.stringify(normalize(xs));
    const c = proj(cached);
    const o = proj(oracle);
    if (c !== o) fail(label, c, o);
  };

  await Product.insertMany(Array.from({ length: 8 }, randDoc));

  for (let i = 0; i < iterations; i++) {
    if (rng() < 0.45) {
      // ---- WRITE ----
      const w = int(7);
      const existing = await ids();
      if (w === 0) {
        log.push("create");
        await Product.create(randDoc());
      } else if (w === 1 && existing.length) {
        const id = pick(existing);
        log.push(`updateOne(${id})`);
        await Product.updateOne({ _id: id }, { $set: randDoc() });
      } else if (w === 2 && existing.length) {
        const id = pick(existing);
        log.push(`findOneAndUpdate(${id})`);
        await Product.findOneAndUpdate({ _id: id }, { $set: { status: pick(STATUSES) } });
      } else if (w === 3 && existing.length) {
        const id = pick(existing);
        log.push(`deleteOne(${id})`);
        await Product.deleteOne({ _id: id });
      } else if (w === 4) {
        log.push("updateMany");
        await Product.updateMany(randPredicate(), { $set: { status: pick(STATUSES) } });
      } else if (w === 5) {
        const newId = new Types.ObjectId();
        log.push(`upsert(${newId})`);
        await Product.updateOne({ _id: newId }, { $set: randDoc() }, { upsert: true });
      } else {
        log.push("bulkWrite");
        await Product.bulkWrite([
          { insertOne: { document: randDoc() } },
          { updateMany: { filter: randPredicate(), update: { $set: { qty: int(10) } } } },
          { deleteOne: { filter: randPredicate() } },
        ]);
      }
    } else {
      // ---- READ (compared against oracle) ----
      const r = int(6);
      if (r === 0) {
        const f = randPredicate();
        await compare(`find ${JSON.stringify(f)}`, (m) => m.find(f).lean().exec());
      } else if (r === 1) {
        const f = randPredicate();
        await compare(`count ${JSON.stringify(f)}`, (m) =>
          m.countDocuments(f).exec() as Promise<unknown>,
        );
      } else if (r === 2) {
        const f = randPredicate();
        await compare(`findOne ${JSON.stringify(f)}`, (m) => m.findOne(f).lean().exec());
      } else if (r === 3) {
        const existing = await ids();
        if (existing.length) {
          const id = pick(existing);
          await compare(`findById ${id}`, (m) => m.findById(id).lean().exec());
        }
      } else if (r === 4) {
        await compare(
          "distinct(status)",
          async (m) => ((await m.distinct("status")) as string[]).sort(),
        );
      } else {
        // order-sensitive top-N: a deterministic sort key (price,_id).
        const f = randPredicate();
        await compare(
          `top3 ${JSON.stringify(f)}`,
          (m) => m.find(f).sort({ price: -1, _id: 1 }).limit(3).lean().exec(),
          true,
        );
      }
    }
  }
  return log.length;
}

describe("differential fuzzer (cache vs uncached oracle)", () => {
  const SEEDS = [0x1234abcd, 0xdeadbeef, 0x0badf00d, 0x5eed1234, 0xfeedface, 0xa5a5a5a5];

  test.each(SEEDS)(
    "cached reads never diverge from MongoDB (seed %#)",
    async (seed) => {
      const comparisons = await runFuzz(seed, 200);
      expect(comparisons).toBeGreaterThan(40);
    },
    60_000,
  );
});

describe("concurrency stress (eventual consistency)", () => {
  test("interleaved parallel reads and writes leave no permanently-stale entry", async () => {
    const rng = makeRng(0x99);
    const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;
    const int = (n: number) => Math.floor(rng() * n);
    const randDoc = () => ({
      status: pick(STATUSES),
      price: int(50),
      qty: int(10),
      category: pick(CATEGORIES),
      tags: [] as string[],
    });

    await Product.insertMany(Array.from({ length: 20 }, randDoc));

    const queries = [
      { status: "active" },
      { price: { $gt: 25 } },
      { category: { $in: ["a", "b"] } },
      {},
    ];

    for (let round = 0; round < 6; round++) {
      const ids = (await Oracle.find({}).distinct("_id")) as Types.ObjectId[];

      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < 40; i++) {
        if (rng() < 0.5) {
          ops.push(Product.find(pick(queries)).lean().exec());
        } else if (ids.length) {
          ops.push(
            Product.updateOne(
              { _id: pick(ids) },
              { $set: { status: pick(STATUSES), price: int(50) } },
            ).exec(),
          );
        } else {
          ops.push(Product.create(randDoc()));
        }
      }
      await Promise.all(ops);

      // After the dust settles, every query must match MongoDB exactly.
      for (const q of queries) {
        const cached = normalize(await Product.find(q).lean());
        const oracle = normalize(await Oracle.find(q).lean());
        expect(cached).toEqual(oracle);
      }
    }
  }, 60_000);
});
