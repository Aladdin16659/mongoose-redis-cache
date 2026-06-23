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
let Author: mongoose.Model<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Book: mongoose.Model<any>;

const counts = { hit: 0, miss: 0, invalidate: 0 };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  Author = mongoose.model("Author", new mongoose.Schema({ name: String }));
  Book = mongoose.model(
    "Book",
    new mongoose.Schema({
      title: String,
      genre: String,
      status: String,
      author: { type: mongoose.Schema.Types.ObjectId, ref: "Author" },
    }),
  );

  redis = new RedisMock() as unknown as Redis;
  cache = createCache({ mongoose, redis, models: { Book: {}, Author: {} } });
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
  await Book.deleteMany({});
  await Author.deleteMany({});
  await redis.flushall();
  counts.hit = 0;
  counts.miss = 0;
  counts.invalidate = 0;
});

describe("aggregation caching", () => {
  test("an aggregation is cached and reused", async () => {
    await Book.insertMany([{ genre: "x" }, { genre: "x" }, { genre: "y" }]);
    const pipeline = [{ $group: { _id: "$genre", n: { $sum: 1 } } }];

    const r1 = await Book.aggregate(pipeline); // miss
    const r2 = await Book.aggregate(pipeline); // hit

    expect(r1).toEqual(r2);
    expect(counts.hit).toBeGreaterThan(0);
  });

  test("a write to the collection invalidates the cached aggregation", async () => {
    await Book.insertMany([{ genre: "x" }, { genre: "x" }]);
    const pipeline = [{ $group: { _id: null, n: { $sum: 1 } } }];

    const before = await Book.aggregate(pipeline);
    expect(before[0]!.n).toBe(2);
    await Book.aggregate(pipeline); // hit

    await Book.create({ genre: "z" });

    const after = await Book.aggregate(pipeline);
    expect(after[0]!.n).toBe(3);
  });

  test("$lookup result is invalidated by a write to the foreign collection", async () => {
    const author = await Author.create({ name: "Ada" });
    await Book.create({ title: "T", author: author._id });
    const pipeline = [
      { $lookup: { from: "authors", localField: "author", foreignField: "_id", as: "a" } },
      { $unwind: "$a" },
      { $project: { _id: 0, title: 1, authorName: "$a.name" } },
    ];

    const r1 = await Book.aggregate(pipeline);
    expect(r1[0]!.authorName).toBe("Ada");
    await Book.aggregate(pipeline); // hit

    // Update the Author — the aggregation was tagged with the authors collection.
    await Author.findOneAndUpdate({ _id: author._id }, { name: "Ada L." });

    const r2 = await Book.aggregate(pipeline);
    expect(r2[0]!.authorName).toBe("Ada L.");
  });

  test("aggregations with $merge/$out are not cached (write stages)", async () => {
    await Book.insertMany([{ genre: "x" }]);
    const pipeline = [
      { $group: { _id: "$genre", n: { $sum: 1 } } },
      { $merge: { into: "book_rollup" } },
    ];
    await Book.aggregate(pipeline);
    await Book.aggregate(pipeline);
    // No hit/miss accounting because the write-stage pipeline bypasses caching.
    expect(counts.hit).toBe(0);
  });
});

describe("distinct caching", () => {
  test("distinct is cached and invalidated when a new value appears", async () => {
    await Book.insertMany([{ genre: "fiction" }, { genre: "fiction" }]);

    expect(await Book.distinct("genre")).toEqual(["fiction"]); // miss
    await Book.distinct("genre"); // hit

    await Book.create({ genre: "scifi" });

    expect((await Book.distinct("genre")).sort()).toEqual(["fiction", "scifi"]);
  });

  test("distinct on different fields does not collide", async () => {
    await Book.create({ genre: "fiction", title: "A" });
    counts.miss = 0;

    await Book.distinct("genre"); // miss
    await Book.distinct("title"); // miss (distinct field is part of the key)

    expect(counts.miss).toBe(2);
  });
});

describe("estimatedDocumentCount caching", () => {
  test("is cached and invalidated by an insert", async () => {
    await Book.insertMany([{ genre: "x" }, { genre: "y" }]);

    expect(await Book.estimatedDocumentCount()).toBe(2); // miss
    await Book.estimatedDocumentCount(); // hit

    await Book.create({ genre: "z" });

    expect(await Book.estimatedDocumentCount()).toBe(3);
  });
});

describe("populate caching", () => {
  test("a populated query reflects an update to the populated document", async () => {
    const author = await Author.create({ name: "Ada" });
    await Book.create({ title: "T", author: author._id });

    const r1 = await Book.find({}).populate("author").lean();
    expect((r1[0]!.author as { name: string }).name).toBe("Ada");
    await Book.find({}).populate("author").lean(); // hit

    await Author.findOneAndUpdate({ _id: author._id }, { name: "Ada L." });

    const r2 = await Book.find({}).populate("author").lean();
    expect((r2[0]!.author as { name: string }).name).toBe("Ada L.");
  });
});

describe("bulkWrite invalidation", () => {
  test("bulkWrite flushes cached queries for the collection", async () => {
    await Book.insertMany([
      { title: "A", status: "active" },
      { title: "B", status: "active" },
    ]);
    const active = async () => (await Book.find({ status: "active" }).lean()).length;

    expect(await active()).toBe(2); // miss -> cache
    await active(); // hit

    await Book.bulkWrite([
      { updateOne: { filter: { title: "B" }, update: { $set: { status: "archived" } } } },
    ]);

    expect(await active()).toBe(1);
  });
});
