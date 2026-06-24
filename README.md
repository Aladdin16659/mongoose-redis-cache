<div align="center">

# @break-limits/mongoose-cache

**A transparent, correctness-first caching layer for Mongoose, backed by Redis.**

Install it once and every read is cached and automatically invalidated — with **zero changes** to your models or queries.

[![npm](https://img.shields.io/npm/v/@break-limits/mongoose-cache.svg)](https://www.npmjs.com/package/@break-limits/mongoose-cache)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![tests](https://img.shields.io/badge/tests-183%20passing-brightgreen.svg)](#correctness--testing)

</div>

---

> **The promise:** this library may serve fewer cache hits than a naive wrapper, but it **never serves stale data**. When it cannot *prove* a cached value is fresh, it doesn't cache it — it falls back to MongoDB. Correctness is the product.

## Table of contents

- [Why](#why)
- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [What gets cached & invalidated](#what-gets-cached--invalidated)
- [Supported query operators](#supported-query-operators)
- [Examples](#examples)
- [Events](#events)
- [Correctness & testing](#correctness--testing)
- [Limitations](#limitations)
- [Requirements & compatibility](#requirements--compatibility)
- [Roadmap](#roadmap)
- [API reference](#api-reference)
- [Development](#development)
- [License](#license)

## Why

Most Mongoose caching libraries make you choose: cache aggressively and risk serving stale data, or invalidate by hand and get it wrong. This library takes a different stance — it classifies every query by how safely it can be invalidated, caches precisely where it can prove freshness, conservatively where it can't, and never where it would be wrong.

The result is a cache you can put in front of production traffic without auditing every query for staleness bugs.

## Features

- 🧠 **Transparent** — no changes to your models or queries. `createCache({ mongoose, redis })` and you're done.
- 🎯 **Precise invalidation** — point reads and predicate queries are invalidated per-document via a membership-transition engine (enter / leave / change / top-N edges).
- 🧮 **Aggregations & joins** — `aggregate()` (including `$lookup`, `$unionWith`, `$graphLookup`) is cached and invalidated by every collection it touches.
- 🔗 **Everything else too** — `find`, `findOne`, `countDocuments`, `distinct`, `estimatedDocumentCount`, and populated queries are all covered.
- ✍️ **Every write path invalidates** — query writes, `save`/`create`, `insertMany`, `replaceOne`, upserts, and `bulkWrite`.
- 🛡️ **Never stale** — verified by a differential fuzzer that runs thousands of random ops against real MongoDB and asserts the cache always matches.
- ⚡ **Stampede-safe** — in-process single-flight collapses concurrent misses for the same key.
- 🔒 **Race-safe** — a version-token guard prevents caching a value that a concurrent write invalidated mid-load.
- 🏚️ **Degrade, never fail** — if Redis is down, reads fall through to MongoDB and writes still succeed.
- 🏢 **Multi-tenant** — first-class tenant keyspace isolation.
- 📦 **Lossless** — BSON-aware serialization preserves `ObjectId`, `Date`, `Decimal128`, and `Buffer`.
- 📊 **Observable** — `hit` / `miss` / `invalidate` / `error` events.
- 🧩 **TypeScript-first** — ships ESM + CJS with full type definitions.

## Install

```bash
npm install @break-limits/mongoose-cache ioredis mongoose
```

`mongoose` (>= 7) and `ioredis` (>= 5) are peer dependencies.

## Quick start

```ts
import mongoose from "mongoose";
import Redis from "ioredis";
import { createCache } from "@break-limits/mongoose-cache";

await mongoose.connect(process.env.MONGO_URI!);
const redis = new Redis(process.env.REDIS_URL!);

const cache = createCache({
  mongoose,
  redis,
  models: {
    Product: { ttlMs: 1_800_000 }, // opt-in, optional TTL backstop
    User: { ttlMs: 300_000 },
  },
});

// From here on, reads are cached and invalidated automatically.
await Product.find({ status: "active" }).lean(); // miss → MongoDB → cached
await Product.find({ status: "active" }).lean(); // hit  → Redis

await Product.findOneAndUpdate({ name: "Widget" }, { status: "active" });
// ^ "Widget" enters the "active" set → the cached query is invalidated.

await Product.find({ status: "active" }).lean(); // miss → reloads with Widget

// Observe what's happening:
cache.on("hit", ({ key }) => {});
cache.on("miss", ({ key }) => {});
cache.on("invalidate", ({ keys }) => {});
```

## How it works

Every query is classified into a **cacheability tier** that determines how it is cached and invalidated:

| Tier | Query shape | Caching | Invalidation |
|------|-------------|---------|--------------|
| **T0** | point read (`findById`, `findOne({_id})`, `find({_id:{$in:[…]}})`) | by document id | **precise** — surgical by id |
| **T1** | predicate query the engine can evaluate in memory | result + predicate | **precise** — membership transitions |
| **T2** | `$where` / `$text` / regex / geo, `distinct`, `estimatedDocumentCount`, populated queries | result + collection tags | **conservative** — any write to a tagged collection |
| **T3** | aggregations (incl. `$lookup` / `$unionWith` / `$graphLookup`) | result + collection tags | **conservative** — any write to any touched collection |
| **T4** | inside a transaction / cursor / `$out` / `$merge` | not cached | n/a |

Two complementary invalidation mechanisms keep both correct:

**Precise (T0/T1).** On every write, the engine takes the changed document's *before-* and *after-images* and evaluates each cached query's predicate against them. It invalidates a cached result when the document:
- was in the result set and changed (direct membership),
- newly matches the predicate (entering),
- no longer matches (leaving), or
- could affect a `limit`ed top-N window.

A predicate is only handled this way if every operator in it is one the engine can faithfully evaluate (the [supported operators](#supported-query-operators)). Anything else is downgraded to conservative — we never run precise invalidation on a predicate we can't reproduce exactly.

**Conservative (T2/T3).** Each entry is tagged with the collection(s) it reads — including foreign collections pulled in by `$lookup` or `populate`. Any write to a tagged collection drains all of its entries. Lower hit rate, still never stale.

Underneath, the cache is protected against the two classic correctness bugs:

- **Cache stampede** — concurrent misses for the same key collapse into a single MongoDB load (in-process single-flight).
- **Write-after-read race** — a per-model version token is captured before the DB read and re-checked before the cache write; if a write bumped it mid-load, the (possibly stale) value is not cached.

## Configuration

```ts
createCache({
  mongoose,              // your Mongoose instance        (required)
  redis,                 // an ioredis client             (required)

  // Opt-in model map. Omit to cache every registered model.
  models: {
    Product: { ttlMs: 1_800_000 },
    Invoice: { enabled: false },      // never cache this model
  },

  defaults: { ttlMs: 600_000 },       // fallback TTL backstop for all models

  tenant: () => getTenantId(),        // keyspace isolation (see below)

  store,                              // optional: override the storage backend
});
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `mongoose` | `Mongoose` | **Required.** Your Mongoose instance. |
| `redis` | `Redis` | **Required.** An `ioredis` client. |
| `models` | `Record<string, ModelConfig>` | Opt-in model map. Omit to cache all registered models. |
| `defaults` | `{ ttlMs?: number }` | Default TTL backstop applied to every model. |
| `tenant` | `() => string \| undefined` | Resolves the current tenant id for keyspace isolation. |
| `store` | `CacheStore` | Override the storage backend (defaults to Redis). |

### Per-model config (`ModelConfig`)

| Field | Type | Description |
|-------|------|-------------|
| `ttlMs` | `number` | TTL backstop in milliseconds. TTL is a *safety net*, not the freshness mechanism — precise/tag invalidation is. |
| `enabled` | `boolean` | Set `false` to bypass caching for this model entirely. |

> **TTL is a backstop, not the source of truth.** Freshness comes from invalidation; TTL only bounds how long an entry can live if something is ever missed. Models that must never be slightly stale (e.g. `Invoice`) can set `enabled: false`.

### Cleanup

`createCache` patches Mongoose interception points on the instance. Call `cache.close()` to restore them (useful in tests or on graceful shutdown):

```ts
const cache = createCache({ mongoose, redis });
// ...
cache.close();
```

## What gets cached & invalidated

**Read operations cached**

| Operation | Tier | Notes |
|-----------|------|-------|
| `find`, `findOne`, `findById` | T0 / T1 | precise; `.lean()` is ideal, hydrated docs are re-hydrated on hit |
| `countDocuments` | T1 | precise |
| `distinct` | T2 | conservative (depends on field values) |
| `estimatedDocumentCount` | T2 | conservative (collection metadata) |
| `aggregate` | T3 | conservative; tagged with every touched collection |
| `find().populate(…)` | T2 | conservative; tagged with root + foreign collections |

Cursor/streaming reads and any query bound to a session/transaction are **never cached**.

**Write operations that invalidate**

`save` · `create` · `insertMany` · `updateOne` · `updateMany` · `findOneAndUpdate` · `replaceOne` · `findOneAndReplace` · `deleteOne` · `deleteMany` · `findOneAndDelete` · upserts · `bulkWrite`

`bulkWrite` and upsert-created documents can't be individually imaged, so they fall back to a conservative model-wide flush — coarse, but never stale.

## Supported query operators

A predicate is invalidated **precisely (T1)** only if every operator in it is one the engine can evaluate exactly. The supported set is:

- **Comparison:** `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`
- **Logical:** `$and`, `$or`, `$nor`, `$not`
- **Element:** `$exists`
- Implicit equality, dot-path nesting (`"a.b"`), and array-contains semantics

Anything else — `$where`, `$text`, `$regex`/RegExp literals, geo operators, `$expr`, a RegExp inside `$in`/`$nin` — is sound to *run* but not to invalidate precisely, so such queries are transparently downgraded to conservative (collection-tag) caching. You don't lose caching; you lose only per-document precision.

## Examples

### Aggregation with a join

```ts
const cache = createCache({ mongoose, redis, models: { Book: {}, Author: {} } });

const byAuthor = await Book.aggregate([
  { $lookup: { from: "authors", localField: "author", foreignField: "_id", as: "a" } },
  { $unwind: "$a" },
  { $group: { _id: "$a.name", count: { $sum: 1 } } },
]);
// Cached, tagged with both `books` and `authors`.

await Author.updateOne({ _id }, { name: "New Name" });
// A write to the authors collection invalidates the cached aggregation.
```

### Multi-tenant isolation

```ts
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage<{ tenantId: string }>();
const cache = createCache({
  mongoose,
  redis,
  models: { Order: {} },
  tenant: () => als.getStore()?.tenantId,
});

// Each tenant gets an isolated cache keyspace; the same query under a different
// tenant is a separate cache entry.
als.run({ tenantId: "acme" }, () => Order.find({ status: "open" }).lean());
```

### Metrics from events

```ts
let hits = 0, misses = 0;
cache.on("hit", () => hits++);
cache.on("miss", () => misses++);

setInterval(() => {
  const total = hits + misses;
  console.log(`hit rate: ${total ? ((hits / total) * 100).toFixed(1) : 0}%`);
}, 10_000);
```

## Events

`createCache` returns an `EventEmitter`. All payloads are plain objects.

| Event | Payload | Emitted when |
|-------|---------|--------------|
| `hit` | `{ key, model }` | a read is served from cache |
| `miss` | `{ key, model }` | a read falls through to MongoDB |
| `invalidate` | `{ keys, model? , collection? }` | cache keys are deleted by a write |
| `error` | `Error` | a cache (Redis) operation fails — the request still succeeds against MongoDB |

> The `error` event is only emitted if you attach a listener, so an unhandled cache error never crashes your process.

## Correctness & testing

Correctness is treated as the product, so it's tested like one — **183 tests**, including a differential fuzzer that is the strongest evidence of the never-stale guarantee:

- **Differential fuzzer** — 6 seeds × 200 random operations against **real MongoDB**. Every random read (`find`, `count`, `findOne`, `findById`, `distinct`, order-sensitive top-N) is compared against the *same query run un-cached*; any divergence fails the test with a reproducible seed. Writes cover every path including upserts and `bulkWrite`.
- **Concurrency stress** — interleaved parallel reads and writes, asserting no permanently-stale entry survives.
- **Membership-transition matrix** — entering / leaving / direct / top-N invalidation edges.
- **No-stale-read race** — a write landing mid-load must not be cached.
- **Degradation** — Redis failures fall through to MongoDB without throwing.
- **Full integration** — aggregation, `$lookup`, populate, distinct, `bulkWrite`, sessions, multi-tenant, pagination — all against `mongodb-memory-server`.

Run them yourself:

```bash
npm test
```

## Limitations

By design, we cache less rather than cache wrong:

1. **Aggregations and T2 queries are invalidated conservatively** (by collection), never per-document. High write volume on involved collections means a lower hit rate for those entries.
2. **Out-of-band writes** — changes made by another service or the Mongo shell are not yet synced (MongoDB Change Streams are on the roadmap). Today, invalidation covers writes made through the Mongoose instance you passed to `createCache`.
3. **Single-node focus** — a shared in-process L1 layer and cross-node pub/sub are on the roadmap. The Redis layer is already shared and safe across nodes; only the optional in-process layer and an atomic Lua version-guard remain.
4. **Conservative entries have a small cross-collection write-race window** — the version guard covers the root collection only; a subsequent write to either collection clears it. Precise (T0/T1) entries have no such window.

## Requirements & compatibility

| | |
|--|--|
| Node.js | >= 18 |
| Mongoose | >= 7 (peer) |
| ioredis | >= 5 (peer) |
| Module formats | ESM + CommonJS, with type definitions |

## Roadmap

- [ ] MongoDB Change Streams for out-of-band write synchronization
- [ ] Cross-node invalidation via Redis Pub/Sub
- [ ] In-process L1 (LRU) layer for microsecond reads
- [ ] Refresh-ahead for conservative entries
- [ ] Atomic Lua version-guarded writes for multi-node precision
- [ ] Prometheus metrics endpoint

## API reference

The primary API is `createCache(options): Cache`. The package also exports its internals for advanced use and custom backends:

- **Plugin:** `createCache`, `Cache`, `CreateCacheOptions`, `ModelConfig`
- **Storage:** `CacheStore`, `InMemoryCacheStore`, `RedisCacheStore`, `DependencyIndex`, `InMemoryDependencyIndex`, `RedisDependencyIndex`
- **Engine:** `CacheManager`, `InvalidationEngine`, `classifyQuery`, `matches`, `isSupportedPredicate`
- **Keys & serialization:** `buildQueryKey`, `buildDocKey`, `normalizeQuery`, `stableHash`, `serialize`, `deserialize`
- **Types:** `Tier`, `Filter`, `Doc`, `CachedQuery`, `CacheKeyInput`, `QueryMeta`, `RegisteredQuery`, `WriteReport`

All are fully typed; see the bundled `.d.ts` for signatures.

## Development

```bash
npm install
npm test         # vitest: unit + integration (mongodb-memory-server) + fuzzer
npm run typecheck
npm run build    # tsup → dist/ (ESM + CJS + types)
```

## License

MIT
