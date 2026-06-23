# @break-limits/mongoose-cache

A transparent, **correctness-first** data acceleration layer for Mongoose backed by Redis.

> The defining promise: the cache may serve fewer hits than a naive library, but it **never serves stale data**. When it can't prove a value is fresh, it doesn't cache it — it falls back to MongoDB.

See [plan.md](./plan.md) for the full architecture and roadmap.

## Install

```bash
npm install @break-limits/mongoose-cache ioredis mongoose
```

## Usage

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
    Product: { ttlMs: 1_800_000 }, // opt-in, with an optional TTL backstop
    User: { ttlMs: 300_000 },
  },
});

// From here, reads are cached and precisely invalidated automatically —
// no changes to your models or queries.
await Product.find({ status: "active" }).lean(); // miss -> MongoDB -> cached
await Product.find({ status: "active" }).lean(); // hit  -> Redis

await Product.findOneAndUpdate({ name: "B" }, { status: "active" });
// ^ B enters the "active" set; the cached query is invalidated automatically.

await Product.find({ status: "active" }).lean(); // miss -> reloads with B

cache.on("hit", (info) => {});
cache.on("miss", (info) => {});
cache.on("invalidate", (info) => {});
```

## How it stays correct

Every query is classified into a **cacheability tier**:

| Tier | Query shape | Behaviour |
|------|-------------|-----------|
| T0 | point read (`findById`, `findOne({_id})`) | cached, surgically invalidated by id |
| T1 | predicate query we can evaluate in-memory | cached, **precisely** invalidated via membership transitions |
| T2 | `$where`/`$text`/regex/geo, `distinct`, `estimatedDocumentCount`, populated queries | cached, **conservatively** invalidated by collection tag |
| T3 | aggregations (incl. `$lookup`/`$unionWith`) | cached, **conservatively** invalidated by every touched collection |
| T4 | inside a transaction / cursor / `$out`/`$merge` | never cached |

Two complementary invalidation mechanisms keep both correct:

- **Precise (T0/T1):** on every write, the engine evaluates the changed document's **before- and after-images** against each cached query's predicate to decide exactly which results could have changed (direct membership, entering, leaving, top-N edges).
- **Conservative (T2/T3):** each entry is tagged with the collection(s) it reads (including `$lookup`/populate foreign collections). Any write to a tagged collection drains it. Lower hit rate, still never stale.

Every read op is covered (`find`, `findOne`, `countDocuments`, `distinct`, `estimatedDocumentCount`, `aggregate`, populate), and every write path invalidates: query writes, `save`/`create`, `insertMany`, `replaceOne`, upserts, and `bulkWrite`.

## Current status (single-node, full Mongoose surface)

Implemented and tested (170 tests):

- Deterministic query fingerprinting & cache keys (tenant-isolated)
- Mongo-accurate predicate matcher + the supported-operator soundness boundary
- Tier classifier with precise (T0/T1) and conservative (T2/T3) paths
- Lossless BSON serializer (ObjectId / Date / Decimal128 / Buffer)
- Precise membership-transition invalidation engine
- Collection-tag invalidation for aggregations, `distinct`, `estimatedDocumentCount`, `$where`/regex queries, and populated queries
- CacheManager with **single-flight** stampede protection and a **version-token race guard** (no stale reads even when a write lands mid-load)
- **Degrade, never fail:** if Redis is down, reads fall through to MongoDB and writes still succeed
- Redis-backed cache store + persistent dependency index (restart-safe)
- Mongoose plugin covering every read op and every write path (query writes, `save`/`create`, `insertMany`, `replaceOne`, upserts, `bulkWrite`)

## Limitations (by design — we cache less rather than cache wrong)

1. **Aggregations / T2 are invalidated conservatively** (by collection), never per-document. High write volume on involved collections means a lower hit rate for those entries — by design.
2. **Out-of-band writes** (from another service or the Mongo shell) are not yet synced — Change Streams land next. Today, invalidation covers writes made through this Mongoose instance.
3. **Single-node** focus. Multi-node L1 + pub/sub and an atomic Lua version-guard are next.
4. Conservative (T2/T3) entries have a small write-race window across `$lookup`/foreign collections (the version guard covers only the root collection); a subsequent write to either collection clears it.

## Development

```bash
npm test         # vitest (unit + integration via mongodb-memory-server)
npm run typecheck
npm run build
```

MIT
