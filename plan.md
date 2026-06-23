# `@break-limits/mongoose-cache` — A Transparent Data Acceleration Layer for Mongoose

## Context

This is a serious, publishable npm package: a transparent caching layer for Mongoose backed by Redis. Install once, and every read, write, update, delete, aggregate, populate, and transaction is intelligently cached and synchronized — with **zero changes to application models or queries**.

```ts
npm install @break-limits/mongoose-cache

import mongoose from "mongoose";
import { createCache } from "@break-limits/mongoose-cache";

await mongoose.connect(process.env.MONGO_URI);
createCache({ mongoose, redis });
```

The defining promise is **correctness first**: the cache may serve fewer hits than a naive library, but it **never serves stale data**. That guarantee is what makes it trustworthy enough to put in front of production traffic.

---

## The Core Idea: Safe-by-Construction Caching

The non-negotiable invariant for every feature below:

> **A read is only served from cache if the cache layer can prove the value is not stale. When it cannot prove freshness, it does not cache — it falls back to MongoDB.**

We never trade correctness for hit rate. We trade *hit rate* for correctness. This is the honest answer to "precise invalidation without failures": precision where provable, safe fallback everywhere else.

### Cacheability Tiers

Every query is classified at intercept time into a tier that determines how it is cached and invalidated:

| Tier | Query shape | Caching | Invalidation strategy |
|------|-------------|---------|----------------------|
| **T0 — Point read** | `findById`, `findOne({_id})`, `find({_id: {$in}})` | Cache by document id | Surgical: invalidate exactly the doc id(s) on any write to them. Trivially correct. |
| **T1 — Predicate query** | `find`/`findOne`/`count`/`distinct` with a filter we can evaluate in-memory (equality, `$in`, `$gt/$lt`, `$and/$or`, etc.) | Cache result + record `{predicate, resultDocIds}` | Precise: on write, evaluate predicate membership transitions (see Invalidation Engine). |
| **T2 — Bounded but unpredicatable** | filters using `$where`, `$text`, geo, regex on non-anchored fields, or `sort+limit` top-N | Cache with collection-tag invalidation | Conservative: any write to the collection invalidates. Correct, lower hit rate. |
| **T3 — Aggregations** | `aggregate()` pipelines | Cache with declared/derived collection dependencies | Conservative by collection(s) touched (`$lookup` included), or user-declared deps. Optionally TTL-only. Never claims per-doc precision. |
| **T4 — Never cache** | inside an uncommitted transaction; queries with `.session()`; non-deterministic ops | Bypass | N/A |

The library **auto-detects** the tier. Users can override per-model/per-query but cannot push a query into a more precise tier than is sound.

---

## Architecture

```
Application code (unchanged Mongoose models & queries)
        │
        ▼
  Mongoose plugin  ──────────────── attached per-schema (NOT global prototype patching)
        │
  ┌─────┴───────────────────────────────────────┐
  ▼                 ▼                ▼            ▼
Query/Aggregate  Write hooks   Change Stream   Transaction
Interceptor      (post)        Listener        guard
  │                 │                │            │
  └─────────────────┼────────────────┼───────────┘
                    ▼                ▼
              Cache Manager  ◄──►  Invalidation Engine
                    │                │
        ┌───────────┼──────────┐     ├── Predicate Matcher (sift-style)
        ▼           ▼          ▼     ├── Dependency Index (doc→queries, query→docs)
   Key Manager  Serializer  Tag Mgr  └── Tier Classifier
        │
        ▼
   L1: in-process LRU  ──►  L2: Redis  ──►  MongoDB
        │
        ▼
   Pub/Sub (Redis) for cross-node L1 invalidation + metrics fan-out
```

### Module layout

```
src/
  index.ts
  cache/        CacheManager.ts  CacheKey.ts  Serializer.ts  Compression.ts
  mongoose/     QueryInterceptor.ts  AggregateInterceptor.ts  ModelInterceptor.ts  PopulateInterceptor.ts
  invalidation/ InvalidationEngine.ts  DependencyIndex.ts  PredicateMatcher.ts  TierClassifier.ts  TagManager.ts
  sync/         ChangeStream.ts  PubSub.ts
  plugins/      CachePlugin.ts
  metrics/      Metrics.ts
  utils/        Hash.ts  Logger.ts
```

### Key architectural decisions

- **Per-schema plugin, not global `Query.prototype.exec` patching.** Patching the prototype globally is invasive, breaks under multiple Mongoose instances, and fights other plugins. We attach via `schema.pre`/`schema.post` and a thin `Query`/`Aggregate` wrapper scoped to registered models. Opt-in per model is safer for a "never break the app" promise.
- **The Invalidation Engine is the center of gravity**, not an afterthought. It owns the Dependency Index and Predicate Matcher.
- **L1 (in-process LRU) requires cross-node invalidation via Pub/Sub** — an L1 cache without distributed invalidation *will* serve stale data on multi-node deployments. L1 is therefore gated behind Pub/Sub being enabled.
- **Degrade, never fail.** Redis down, Change Stream unavailable, serialization error → log + fall through to MongoDB. Caching is an accelerator, never a dependency.

---

## The Invalidation Engine (the hard part, done right)

Precise invalidation = correctly answering, for every write, *"which cached entries could this write have changed?"*

### Data structures (in Redis)

- `doc:<model>:<id>` → cached document body (T0).
- `q:<model>:<keyhash>` → cached query result + metadata `{ predicate, resultDocIds[], tier, createdAt }`.
- `idx:doc→q:<model>:<id>` → Redis SET of query keys whose result set currently contains this doc.
- `idx:pred:<model>` → registry of active T1 predicates (for newly-matching detection).
- `tag:<name>` → SET of cache keys (collection tags, user tags).

### On write (the membership-transition algorithm)

For a changed document `D` in model `M`, with **old image** `D_before` and **new image** `D_after`:

1. **T0 / doc:** `DEL doc:M:<id>`.
2. **Direct membership (doc was in a result):** for every query key in `idx:doc→q:M:<id>`, invalidate it (the doc it contained changed). Remove the doc from those sets.
3. **Entering membership (newly matches a predicate):** for every active T1 predicate `P` in `idx:pred:M`, evaluate `matches(P, D_after)`. If `D_before` did **not** match but `D_after` does → the result set should grow → invalidate every query keyed on `P`.
4. **Leaving membership:** if `D_before` matched `P` but `D_after` does not → invalidate.
5. **Top-N / limit safety:** if `P` has a `limit`, treat *any* match by `D_after` OR `D_before` as a potential change to the limited window → invalidate (we cannot cheaply know rank). This keeps T1+limit correct.
6. **T2/T3 fallback:** invalidate `tag:<collection>` (and tags for collections reachable via `$lookup` for T3).

The membership transitions (steps 3–5) require **both before- and after-images** of the document:

- **Inside our own write hooks** we have the query/update and can compute or fetch both images.
- **For out-of-band writes** (another service, mongo shell), we rely on **Change Streams with pre- and post-images** (`fullDocumentBeforeChange` + `fullDocument`), which requires MongoDB 6.0+ with `changeStreamPreAndPostImages` enabled on the collection. **If pre-images are unavailable, T1 precision is not sound for out-of-band writes → the engine automatically downgrades affected models to T2 (collection-tag invalidation) and logs a clear warning.** Safe by construction.

### Predicate Matcher

In-memory evaluation of a Mongo filter against a single document (the `sift`-style operation). The Tier Classifier only assigns **T1** to filters composed entirely of operators the matcher provably supports; anything else → T2. This is the boundary that guarantees "no failures": we never run precise invalidation on a predicate we can't faithfully evaluate.

### Write-after-read race (cache stampede + consistency)

Two classic correctness bugs, explicitly handled:

- **Stale-set race:** reader misses → reads old value from Mongo → concurrent writer commits + invalidates → reader writes stale value into cache. **Fix:** per-key monotonic version token. On miss we capture the model's version counter before the DB read; on set we use a Lua `SET if version unchanged` — if a write bumped the version mid-read, we skip the cache set.
- **Cache stampede (thundering herd):** N concurrent misses for the same key all hit Mongo. **Fix:** single-flight via a short Redis lock (`SET NX PX`); losers briefly wait/poll for the winner's result, or fall through to Mongo with jitter. Configurable.

---

## Feature Breakdown (full vision, with depth + phase tags)

**P1** = MVP correctness core, **P2** = production hardening, **P3** = advanced/differentiators.

### Read path
- **Query Interceptor** *(P1)* — wraps `find/findOne/findById/count/distinct/exists/estimatedDocumentCount` via plugin. `lean()` results are ideal (already plain objects). `.cursor()`/streaming = **not cached** (T4-like). `estimatedDocumentCount` is collection-metadata, TTL-only.
- **Aggregate Interceptor** *(P2)* — T3. Cache by `hash(pipeline)`; dependency = collections in pipeline (root + every `$lookup.from` + `$unionWith`). Conservative invalidation only. Document this limitation prominently.
- **Populate caching** *(P2)* — populated refs are point reads → cache each populated doc at T0 and assemble. Invalidation rides T0 doc invalidation. Nested populate = recurse.

### Write path
- **Write Interceptor** *(P1)* — post-hooks on `save/insertMany/updateOne/updateMany/replaceOne/findOneAndUpdate/deleteOne/deleteMany/findOneAndDelete/bulkWrite`. Each computes before/after images (fetch before-image when the update operator needs it; cheap for `findOneAnd*` which can return it) and drives the Invalidation Engine. `bulkWrite` decomposed per-op.

### Keys & storage
- **Cache Key Generator** *(P1)* — deterministic. Inputs: model, op, **normalized** filter, projection, sort, skip, limit, populate spec, collation, tenant, schema-version, lib-version. Hash via **xxhash** (fast, non-crypto is fine for keys) with collision-safe length.
- **Query Fingerprinting / normalization** *(P1)* — `{a:1,b:2}` ≡ `{b:2,a:1}`. Recursively sort object keys, canonicalize operators, normalize ObjectId/Date/RegExp to stable forms before hashing.
- **Serializer** *(P1)* — never store hydrated Mongoose docs. Store BSON-aware data (preserve `ObjectId`, `Date`, `Decimal128`, `Buffer`) so rehydration is lossless.
- **Compression** *(P2)* — gzip/brotli above a configurable threshold (default ~1KB — Redis memory and network both benefit early). Store a 1-byte codec header.

### Invalidation & sync
- **Tag Manager** *(P1)* — collection tags (automatic) + user tags (per-model config). Backs T2/T3 invalidation. Use Redis SETs; clean up tag membership on key expiry via the Auto Cleanup worker.
- **Dependency Graph** *(P2)* — the manual `{Product: ['Inventory','Dashboard']}` config is reframed honestly: it is a **coarse user-declared tag-cascade** for T3/derived caches (dashboards, reports) that the engine *cannot* infer. It is NOT how T0/T1 precision works (that's automatic via the Dependency Index). Both coexist; documentation makes the distinction explicit so users aren't misled.
- **Change Stream Synchronizer** *(P2)* — `collection.watch()` with pre/post images. Handles out-of-band writes. **Requires replica set** (or Atlas). On standalone Mongo it is unavailable → log once, run without it, and keep T1 sound only for in-process writes (others downgrade to T2). Resume tokens persisted for restart safety.
- **Pub/Sub** *(P2)* — Redis pub/sub broadcasts invalidations so every node drops its **L1** entries and so single-node Change Stream events propagate cluster-wide. Mandatory when L1 is enabled.

### Performance layers
- **L1 in-process LRU** *(P3)* — microsecond reads. Gated behind Pub/Sub (else stale across nodes). Small, TTL-bounded, with the same version-token guard.
- **Smart TTL** *(P2)* — per-model defaults; TTL is a *backstop*, not the freshness mechanism (precise invalidation is). `enabled:false` models bypass entirely (e.g. Invoices).
- **Refresh Ahead** *(P3)* — when TTL is the freshness source (T2/T3), background-refresh at ~80% of TTL so users never wait. Not needed for precisely-invalidated tiers.
- **Cache Policies** *(P3)* — cache-first / network-first / write-through / write-around / write-behind. Default cache-aside + write-around (write to Mongo, invalidate cache) which is the safest. Write-behind is opt-in and clearly marked as relaxing durability.

### Operational
- **Multi-Tenant** *(P1)* — tenant id is a first-class key component (`tenant:5:...`); full key-space isolation. Pluggable tenant resolver (from query context/asyncLocalStorage).
- **Transaction Awareness** *(P1)* — reads with an active session = **T4, never cached** (uncommitted/snapshot data must not poison the shared cache). Writes in a transaction defer all invalidation until `commitTransaction()`; on abort, discard. Hook `session` lifecycle.
- **Metrics** *(P2)* — hits, misses, hit %, invalidations, redis/mongo latency histograms, compression ratio, memory, per-model breakdown, slowest queries, downgrade counts (how often we fell back T1→T2). Exposed as an object + optional Prometheus endpoint.
- **Events** *(P2)* — `hit/miss/set/invalidate/error/downgrade` EventEmitter hooks for logging/monitoring.
- **Auto Cleanup** *(P3)* — background worker reaps orphaned tag members, expired version tokens, stale resume artifacts.

### Config surface
```ts
createCache({
  mongoose, redis,
  defaults: { ttl: 600, compression: true },
  models: {
    User:    { ttl: 300, tags: ['user'] },
    Product: { ttl: 1800, refreshAhead: true, tags: ['inventory','catalog'] },
    Invoice: { enabled: false },
  },
  derivedDependencies: {           // coarse cascade for T3/derived caches only
    Product: ['Inventory','Dashboard'],
  },
  pubsub: true, changeStreams: true, l1: { enabled: true, max: 5000 },
  tenant: (ctx) => ctx.tenantId,
  metrics: true, debug: false,
  onDowngrade: (info) => {},        // observability for safety fallbacks
});
```

Lifecycle events:
```ts
cache.on("hit", info => {});
cache.on("miss", info => {});
cache.on("set", info => {});
cache.on("invalidate", info => {});
cache.on("downgrade", info => {});   // a model fell back to a less precise tier
cache.on("error", err => {});
```

---

## Phasing / Milestones

- **Phase 1 — Correct MVP (T0/T1 core).** Plugin wiring, key gen + fingerprinting, serializer, Redis L2, point + predicate read caching, write hooks with in-process before/after images, Predicate Matcher, Dependency Index, version-token race guard, single-flight stampede guard, transaction guard (T4), multi-tenant keys. **Deliverable:** caches correctly for single-node apps with no stale reads, and degrades safely when Redis is down. Ship as `0.x`.
- **Phase 2 — Production hardening / multi-node.** Aggregate (T3) + populate caching, Change Streams w/ pre-images + auto-downgrade, Pub/Sub, tags + derived dependency cascade, compression, smart TTL, metrics + events. **Deliverable:** safe on replica-set + multi-node clusters.
- **Phase 3 — Differentiators.** L1 LRU, refresh-ahead, cache policies, write-behind, auto-cleanup worker, pluggable backends (key gen/serializer/storage), Prometheus. **Deliverable:** `1.0` — the "data acceleration platform."

---

## Tech Stack & Tooling

- **Language:** TypeScript, strict mode. Ship ESM + CJS (`tsup`). Full type defs (peer-typed against installed `mongoose`).
- **Peer deps:** `mongoose` (>=7), a Redis client — **`ioredis`** (cluster + Lua support; better than `node-redis` for our Lua/cluster needs). Lua scripts for atomic version-guarded set and single-flight.
- **Predicate matching:** `sift` (vetted) or a constrained in-house matcher whose supported-operator set defines the T1 boundary.
- **Hashing:** `xxhash-wasm` / `xxhashjs`.
- **Testing:** `vitest` + `mongodb-memory-server` (replica-set mode for Change Streams) + a real Redis via `testcontainers` (or `ioredis-mock` for unit).
- **CI:** GitHub Actions matrix over Mongo 6/7/8 and Node LTS; lint (eslint) + typecheck + coverage gate.
- **Release:** `changesets`, semantic versioning, provenance, clear `0.x` stability disclaimer.

---

## Testing Strategy (correctness is the product)

The test suite is the proof of the "never stale" promise. Beyond basic CRUD/TTL/multi-tenant coverage, add **adversarial concurrency/consistency tests**:

- **No-stale-read invariant tests:** for each tier, interleave writes and reads under concurrency and assert the cache never returns a value MongoDB wouldn't.
- **Membership transition matrix (T1):** doc enters/leaves predicate via insert/update/delete/replace, including `$or`, `$in`, range, and `sort+limit` top-N edges.
- **Race conditions:** write-after-read stale-set race; stampede single-flight; transaction commit/abort ordering.
- **Change Stream:** out-of-band writes, pre-image present vs absent (assert auto-downgrade to T2), resume-after-disconnect.
- **Multi-node:** two processes sharing Redis; assert L1 invalidation via pub/sub.
- **Failure injection:** Redis down/reconnect, serialization failure, Mongo error → assert fall-through to Mongo, never a thrown error to the app.
- **Multi-tenant isolation;** TTL expiry; compression round-trip with BSON types; memory/stress soak.

A property-based fuzzer (random schemas, random query+write sequences, oracle = direct Mongo) is the strongest evidence and a P2 goal.

---

## Honest Limitations (state these in the README)

A serious package earns trust by naming its boundaries:

1. **Aggregations (T3) are invalidated conservatively** (by collection), never per-document. High write volume on involved collections = low aggregate hit rate. By design.
2. **Precise T1 invalidation for out-of-band writes needs MongoDB 6.0+ pre/post images on a replica set.** Otherwise those models auto-downgrade to T2. We never silently serve stale data; we cache less.
3. **`$where`, `$text`, geo, and complex regex** are T2 (collection-tag) — the matcher can't soundly evaluate them.
4. **Write-behind policy** relaxes durability and is opt-in only.
5. **L1 requires pub/sub**; without it, L1 is disabled to prevent cross-node staleness.

---

## Open Decisions (to resolve at implementation start)

1. **Serializer format:** BSON binary (lossless types, slightly larger) vs. EJSON/JSON (ubiquitous, needs type reviver). Leaning **BSON** for correctness with `Decimal128`/`Buffer`.
2. **Predicate matcher:** depend on `sift` vs. in-house. Leaning **in-house constrained matcher** so the T1 operator boundary is ours to guarantee and audit.
3. **Opt-in vs. opt-out per model:** leaning **opt-in** (`models` map) for the "never break the app" promise, with a `defaults` block for convenience.

---

## Verification (how we'll know it's right)

- `vitest run` green across the Mongo/Node CI matrix, with the **no-stale-read invariant** and **membership-transition** suites passing — these are the acceptance gate, not nice-to-haves.
- A runnable `examples/` app (Express + Mongoose) demonstrating: point reads, predicate queries, an aggregation, out-of-band write sync, and a two-node pub/sub invalidation demo, each with before/after latency + hit-rate metrics printed.
- Manual replica-set demo (via `mongodb-memory-server` RS mode) proving Change Stream sync and auto-downgrade when pre-images are off.

---

## Final Vision

More than a cache library — a **transparent data acceleration platform** for Mongoose, defined by:

- Zero changes to application models or queries.
- **Never serves stale data** — correctness is the product.
- Automatic, precise invalidation where provable; safe conservative fallback everywhere else.
- Automatic synchronization from MongoDB (including out-of-band writes) to Redis.
- Cluster-safe operation via Redis Pub/Sub.
- High observability with metrics and events, including visibility into safety downgrades.
- Production-ready transactions, multi-tenancy, compression, and failure recovery.
- Extensible architecture (custom key generators, serializers, invalidation strategies, storage backends).
