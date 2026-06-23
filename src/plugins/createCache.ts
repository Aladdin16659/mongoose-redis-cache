import { EventEmitter } from "node:events";
import type { Mongoose, Model } from "mongoose";
import type { Redis } from "ioredis";
import { RedisCacheStore } from "../cache/RedisCacheStore.js";
import { RedisDependencyIndex } from "../invalidation/RedisDependencyIndex.js";
import { InvalidationEngine } from "../invalidation/InvalidationEngine.js";
import { CacheManager, type CachedQuery } from "../cache/CacheManager.js";
import type { CacheStore } from "../cache/CacheStore.js";
import { classifyQuery } from "../invalidation/TierClassifier.js";
import { buildQueryKey, buildAggregateKey } from "../cache/CacheKey.js";
import type { Doc, Filter } from "../invalidation/PredicateMatcher.js";
import { idToString } from "../utils/id.js";

export interface ModelConfig {
  ttlMs?: number;
  enabled?: boolean;
}

export interface CreateCacheOptions {
  mongoose: Mongoose;
  redis: Redis;
  /** Override the storage backend (e.g. for testing). Defaults to Redis. */
  store?: CacheStore;
  /** Opt-in model map. Omit to cache every currently-registered model. */
  models?: Record<string, ModelConfig>;
  defaults?: { ttlMs?: number };
  /** Resolve the current tenant id for keyspace isolation. */
  tenant?: () => string | undefined;
}

export interface Cache extends EventEmitter {
  /** Restore all patched Mongoose methods. */
  close(): void;
}

// Read ops we cache. Point/predicate reads (find/findOne/countDocuments) are
// invalidated precisely; distinct/estimatedDocumentCount conservatively.
const CACHE_OPS = new Set([
  "find",
  "findOne",
  "countDocuments",
  "distinct",
  "estimatedDocumentCount",
]);
const UPDATE_OPS = new Set([
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
]);
const DELETE_OPS = new Set([
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
]);

export function createCache(options: CreateCacheOptions): Cache {
  const { mongoose } = options;
  const emitter = new EventEmitter() as Cache;

  const store = options.store ?? new RedisCacheStore(options.redis);
  const index = new RedisDependencyIndex(options.redis);
  const engine = new InvalidationEngine(index);
  const manager = new CacheManager(store, engine, emitter);

  const registry = new Map<string, ModelConfig>();
  const modelNames = options.models
    ? Object.keys(options.models)
    : mongoose.modelNames();
  for (const name of modelNames) {
    registry.set(name, options.models?.[name] ?? {});
  }

  // Queries we issue internally (before/after image fetches) skip the cache.
  const bypass = new WeakSet<object>();
  const tenant = () => options.tenant?.();
  const ttlFor = (config: ModelConfig) => config.ttlMs ?? options.defaults?.ttlMs;
  const collectionOf = (model: Model<unknown>) => model.collection.collectionName;

  // ----- internal image fetches ---------------------------------------------
  async function fetchMatching(model: Model<unknown>, filter: Filter) {
    const q = model.find(filter).lean();
    bypass.add(q);
    return (await q.exec()) as Doc[];
  }
  async function fetchById(model: Model<unknown>, id: unknown) {
    const q = model.findOne({ _id: id }).lean();
    bypass.add(q);
    return (await q.exec()) as Doc | null;
  }

  // ----- write invalidation (precise + conservative) ------------------------
  async function invalidateWrite(
    model: Model<unknown>,
    pairs: Array<{ before: Doc | null; after: Doc | null }>,
    opts: { flushPrecise?: boolean } = {},
  ) {
    const modelName = model.modelName;
    if (pairs.length === 0) {
      // No imaged docs — still bump the version to close the read race window.
      await manager.onWrite(modelName, null, null);
    } else {
      for (const { before, after } of pairs) {
        await manager.onWrite(modelName, before, after);
      }
    }
    if (opts.flushPrecise) await manager.flushModelPrecise(modelName);
    // Conservative: drain everything tagged with this collection (T2/T3/etc.).
    await manager.invalidateCollection(collectionOf(model));
  }

  // ----- read handling ------------------------------------------------------
  async function handleRead(query: any, op: string, config: ModelConfig) {
    const filter = (query.getFilter() ?? {}) as Filter;
    const opts = query.getOptions() ?? {};
    const tier = classifyQuery({ op, filter, hasSession: !!opts.session });
    if (tier === "T4") return originalExec.apply(query, []);

    const model = query.model as Model<unknown>;
    const collection = collectionOf(model);
    const populatePaths = Object.keys(query._mongooseOptions?.populate ?? {});
    const hasPopulate = populatePaths.length > 0;

    // distinct depends on field values beyond set membership, and populate /
    // T2 filters can't be evaluated precisely — all use conservative tagging.
    const conservative =
      op === "distinct" ||
      op === "estimatedDocumentCount" ||
      hasPopulate ||
      tier === "T2";

    let tags: string[] | undefined;
    if (conservative) {
      tags = [collection];
      if (hasPopulate) {
        const popCols = resolvePopulateCollections(query, populatePaths);
        if (popCols === null) return originalExec.apply(query, []); // unresolved → don't cache
        tags = [collection, ...popCols];
      }
    }

    const lean = !!query._mongooseOptions?.lean;
    const key = buildQueryKey({
      model: model.modelName,
      op,
      filter,
      projection: query.projection?.() ?? null,
      sort: opts.sort ?? null,
      skip: opts.skip,
      limit: opts.limit,
      populate: hasPopulate ? populatePaths : null,
      distinct: query._distinct ?? null,
      tenant: tenant(),
    });

    const cached: CachedQuery = {
      key,
      model: model.modelName,
      tier,
      predicate: conservative ? undefined : filter,
      limited: opts.limit !== undefined && opts.limit !== null,
      tags,
      ttlMs: ttlFor(config),
    };

    const plain = await manager.getOrLoad(
      cached,
      async () => toPlain(await originalExec.apply(query, [])),
      extractIds,
    );

    return lean || hasPopulate ? plain : rehydrate(model, op, plain);
  }

  // ----- query write handling -----------------------------------------------
  async function handleWrite(query: any, op: string) {
    const model = query.model as Model<unknown>;
    const filter = (query.getFilter() ?? {}) as Filter;
    const opts = query.getOptions() ?? {};

    const beforeDocs = await fetchMatching(model, filter);
    const result = await originalExec.apply(query, []);

    const isDelete = DELETE_OPS.has(op);
    const pairs: Array<{ before: Doc | null; after: Doc | null }> = [];
    for (const before of beforeDocs) {
      const after = isDelete ? null : await fetchById(model, before._id);
      pairs.push({ before, after });
    }

    // An upsert may have created a document we never imaged — flush precisely.
    const flushPrecise = !!opts.upsert && beforeDocs.length === 0;
    await invalidateWrite(model, pairs, { flushPrecise });

    return result;
  }

  // ----- exec wrapper (queries) ---------------------------------------------
  const queryProto = (mongoose as unknown as { Query: { prototype: any } }).Query
    .prototype;
  const originalExec: (...args: unknown[]) => Promise<unknown> = queryProto.exec;

  function wrappedExec(this: any, ...args: unknown[]): Promise<unknown> {
    if (bypass.has(this)) return originalExec.apply(this, args);
    const config = this.model ? registry.get(this.model.modelName) : undefined;
    if (!config || config.enabled === false) return originalExec.apply(this, args);

    const op: string = this.op;
    if (CACHE_OPS.has(op)) return handleRead(this, op, config);
    if (UPDATE_OPS.has(op) || DELETE_OPS.has(op)) return handleWrite(this, op);
    return originalExec.apply(this, args);
  }
  queryProto.exec = wrappedExec;

  const restores: Array<() => void> = [
    () => {
      queryProto.exec = originalExec;
    },
  ];

  // ----- aggregate interceptor ----------------------------------------------
  const aggProto = (mongoose as unknown as { Aggregate: { prototype: any } })
    .Aggregate.prototype;
  const originalAggExec: (...args: unknown[]) => Promise<unknown> = aggProto.exec;

  async function handleAggregate(agg: any, config: ModelConfig) {
    const model = agg._model as Model<unknown>;
    const pipeline: any[] = typeof agg.pipeline === "function" ? agg.pipeline() : agg._pipeline ?? [];

    // Write stages ($out/$merge) and session-bound aggregations are never cached.
    if (hasWriteStage(pipeline) || agg.options?.session) {
      return originalAggExec.apply(agg, []);
    }

    const tags = collectionsInPipeline(model, pipeline);
    const cached: CachedQuery = {
      key: buildAggregateKey(model.modelName, pipeline, tenant()),
      model: model.modelName,
      tier: "T3",
      tags,
      ttlMs: ttlFor(config),
    };
    return manager.getOrLoad(cached, async () => originalAggExec.apply(agg, []));
  }

  aggProto.exec = function wrappedAggExec(this: any, ...args: unknown[]) {
    const config = this._model ? registry.get(this._model.modelName) : undefined;
    if (!config || config.enabled === false) return originalAggExec.apply(this, args);
    return handleAggregate(this, config);
  };
  restores.push(() => {
    aggProto.exec = originalAggExec;
  });

  // ----- save / insertMany / bulkWrite interception -------------------------
  for (const name of registry.keys()) {
    const model = mongoose.models[name] as Model<unknown> | undefined;
    if (!model) continue;

    // `Model.create` routes through `$save`; `doc.save()` through `save`
    // (which delegates to `$save`). Patch both with a re-entrancy guard so
    // invalidation runs once per logical save.
    const proto = model.prototype as any;
    const saving = new WeakSet<object>();
    const makePatched =
      (original: (...args: unknown[]) => Promise<unknown>) =>
      async function patchedSave(this: any, ...a: unknown[]) {
        if (saving.has(this)) return original.apply(this, a);
        saving.add(this);
        try {
          const isNew = this.isNew;
          const before = isNew ? null : await fetchById(model, this._id);
          const res = await original.apply(this, a);
          const after = this.toObject() as Doc;
          await invalidateWrite(model, [{ before, after }]);
          return res;
        } finally {
          saving.delete(this);
        }
      };

    const originalSave = proto.save;
    proto.save = makePatched(originalSave);
    restores.push(() => {
      proto.save = originalSave;
    });
    if (typeof proto.$save === "function") {
      const original$save = proto.$save;
      proto.$save = makePatched(original$save);
      restores.push(() => {
        proto.$save = original$save;
      });
    }

    const originalInsertMany = model.insertMany.bind(model);
    (model as any).insertMany = async function patchedInsertMany(...a: unknown[]) {
      const res: any = await (originalInsertMany as any)(...a);
      const docs = Array.isArray(res) ? res : [res];
      await invalidateWrite(
        model,
        docs.map((d: any) => ({
          before: null,
          after: (typeof d?.toObject === "function" ? d.toObject() : d) as Doc,
        })),
      );
      return res;
    };
    restores.push(() => {
      (model as any).insertMany = originalInsertMany;
    });

    // bulkWrite mixes arbitrary ops we cannot image — flush the model's precise
    // registry and drain its collection tag (coarse but never stale).
    const originalBulkWrite = model.bulkWrite.bind(model);
    (model as any).bulkWrite = async function patchedBulkWrite(...a: unknown[]) {
      const res = await (originalBulkWrite as any)(...a);
      await invalidateWrite(model, [], { flushPrecise: true });
      return res;
    };
    restores.push(() => {
      (model as any).bulkWrite = originalBulkWrite;
    });
  }

  emitter.close = () => {
    for (const restore of restores) restore();
  };
  return emitter;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function hasWriteStage(pipeline: any[]): boolean {
  return pipeline.some((s) => s && (s.$out !== undefined || s.$merge !== undefined));
}

function collectionsInPipeline(model: Model<unknown>, pipeline: any[]): string[] {
  const cols = new Set<string>([model.collection.collectionName]);
  for (const stage of pipeline) {
    if (!stage) continue;
    if (stage.$lookup?.from) cols.add(stage.$lookup.from);
    if (stage.$graphLookup?.from) cols.add(stage.$graphLookup.from);
    if (stage.$unionWith) {
      cols.add(
        typeof stage.$unionWith === "string" ? stage.$unionWith : stage.$unionWith.coll,
      );
    }
  }
  return [...cols];
}

function resolvePopulateCollections(query: any, paths: string[]): string[] | null {
  const pop = query._mongooseOptions?.populate ?? {};
  const cols: string[] = [];
  for (const path of paths) {
    const opt = pop[path] ?? {};
    let ref: unknown = opt.model;
    if (typeof ref !== "string") {
      const sp = query.model.schema.path(path);
      ref = sp?.options?.ref ?? sp?.caster?.options?.ref;
    }
    if (typeof ref !== "string") return null; // dynamic/unresolvable ref → don't cache
    const refModel = query.model.db.models[ref];
    if (!refModel) return null;
    cols.push(refModel.collection.collectionName);
  }
  return cols;
}

function toPlain(result: unknown): unknown {
  if (Array.isArray(result)) return result.map((d) => toPlainDoc(d));
  return toPlainDoc(result);
}

function toPlainDoc(doc: unknown): unknown {
  if (doc && typeof (doc as { toObject?: unknown }).toObject === "function") {
    return (doc as { toObject(): unknown }).toObject();
  }
  return doc;
}

function rehydrate(model: any, op: string, plain: unknown): unknown {
  if (op === "find") return (plain as unknown[]).map((o) => model.hydrate(o));
  if (op === "findOne") return plain ? model.hydrate(plain) : null;
  return plain;
}

function extractIds(plain: unknown): string[] {
  const collect = (d: unknown): string | undefined =>
    d && typeof d === "object" && "_id" in d
      ? idToString((d as { _id: unknown })._id)
      : undefined;
  if (Array.isArray(plain)) {
    return plain.map(collect).filter((s): s is string => s !== undefined);
  }
  const single = collect(plain);
  return single ? [single] : [];
}
