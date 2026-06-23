import type { EventEmitter } from "node:events";
import type { CacheStore } from "./CacheStore.js";
import { serialize, deserialize } from "./Serializer.js";
import { buildTagKey } from "./CacheKey.js";
import type { InvalidationEngine } from "../invalidation/InvalidationEngine.js";
import type { Filter, Doc } from "../invalidation/PredicateMatcher.js";
import type { Tier } from "../invalidation/TierClassifier.js";

export interface CachedQuery {
  key: string;
  model: string;
  tier: Tier;
  predicate?: Filter | undefined;
  limited?: boolean | undefined;
  ttlMs?: number | undefined;
  /** Collection names to tag this entry with (conservative T2/T3 invalidation). */
  tags?: string[] | undefined;
}

/**
 * Ties together the store, serializer, and invalidation engine into the
 * read/write caching brain. Guarantees the no-stale-read invariant via a
 * version-token race guard and prevents stampedes via in-process single-flight.
 */
export class CacheManager {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: CacheStore,
    private readonly engine: InvalidationEngine,
    private readonly events?: EventEmitter,
  ) {}

  /**
   * Return the cached value for a query, or load it via `loader`, cache it
   * (when safe), and register it for precise invalidation.
   *
   * @param extractIds maps a loaded result to the stable string ids of the
   *   documents it contains — required for T1 direct-membership invalidation.
   */
  async getOrLoad<T>(
    query: CachedQuery,
    loader: () => Promise<T>,
    extractIds: (result: T) => string[] = () => [],
  ): Promise<T> {
    if (query.tier === "T4") return loader();

    // Degrade, never fail: if the cache read throws (Redis down), fall through
    // to the loader rather than surfacing the error to the application.
    let cached: Buffer | null = null;
    try {
      cached = await this.store.get(query.key);
    } catch (err) {
      this.emitError(err);
      return loader();
    }
    if (cached !== null) {
      this.events?.emit("hit", { key: query.key, model: query.model });
      return deserialize(cached) as T;
    }
    this.events?.emit("miss", { key: query.key, model: query.model });

    // Single-flight: collapse concurrent misses for the same key.
    const existing = this.inflight.get(query.key);
    if (existing) return existing as Promise<T>;

    const work = this.loadAndCache(query, loader, extractIds);
    this.inflight.set(query.key, work);
    try {
      return await work;
    } finally {
      this.inflight.delete(query.key);
    }
  }

  private async loadAndCache<T>(
    query: CachedQuery,
    loader: () => Promise<T>,
    extractIds: (result: T) => string[],
  ): Promise<T> {
    // Capture the version BEFORE reading Mongo so a concurrent write that
    // bumps it mid-load causes us to skip caching a possibly-stale value.
    // If we cannot read the version, we cannot prove freshness — so we load
    // but do not cache (correctness over hit-rate).
    let versionBefore: number;
    try {
      versionBefore = await this.store.getVersion(query.model);
    } catch (err) {
      this.emitError(err);
      return loader();
    }

    const result = await loader();

    let versionAfter: number;
    try {
      versionAfter = await this.store.getVersion(query.model);
    } catch (err) {
      this.emitError(err);
      return result;
    }

    if (versionBefore !== versionAfter) {
      // A write landed during our load — do not cache (no-stale-read guard).
      return result;
    }

    try {
      await this.store.set(query.key, serialize(result), query.ttlMs);

      // A predicate is only supplied for precisely-invalidatable tiers (T0/T1),
      // so its presence is the signal to register for membership tracking.
      if (query.predicate) {
        await this.engine.registerQuery(query.model, query.key, {
          predicate: query.predicate,
          limited: query.limited ?? false,
          resultDocIds: extractIds(result),
        });
      }

      // Conservative tiers (T2/T3) tag the entry by collection so that any
      // write to a tagged collection drains it.
      for (const tag of query.tags ?? []) {
        await this.store.addToSet(buildTagKey(tag), query.key);
      }
    } catch (err) {
      this.emitError(err);
    }

    return result;
  }

  /**
   * Apply a write: bump the model version (closing the race window), run the
   * invalidation engine, and delete every affected cache key.
   */
  async onWrite(
    model: string,
    before: Doc | null,
    after: Doc | null,
    extraKeys: string[] = [],
  ): Promise<string[]> {
    // The Mongo write has already committed by the time we get here, so a
    // Redis failure must never throw back into the application path.
    try {
      await this.store.bumpVersion(model);
      const report = await this.engine.onWrite(model, before, after);
      const keys = [...report.invalidatedQueryKeys, ...extraKeys];
      if (keys.length > 0) {
        await this.store.del(keys);
        this.events?.emit("invalidate", { model, keys });
      }
      return keys;
    } catch (err) {
      this.emitError(err);
      return [];
    }
  }

  /**
   * Conservative invalidation: drain a collection's tag and delete every
   * entry tagged with it (T2/T3/distinct/populate). Degrade-safe.
   */
  async invalidateCollection(collection: string): Promise<string[]> {
    try {
      const keys = await this.store.drainSet(buildTagKey(collection));
      if (keys.length > 0) {
        await this.store.del(keys);
        this.events?.emit("invalidate", { collection, keys });
      }
      return keys;
    } catch (err) {
      this.emitError(err);
      return [];
    }
  }

  /**
   * Nuclear precise fallback: remove every registered T1 query for a model and
   * delete its cache keys. Used for writes we cannot image (bulkWrite, upserts).
   */
  async flushModelPrecise(model: string): Promise<string[]> {
    try {
      const keys = await this.engine.clearQueries(model);
      if (keys.length > 0) {
        await this.store.del(keys);
        this.events?.emit("invalidate", { model, keys });
      }
      return keys;
    } catch (err) {
      this.emitError(err);
      return [];
    }
  }

  /**
   * Emit an `error` event without crashing: a bare `error` emit on an
   * EventEmitter with no listeners would itself throw.
   */
  private emitError(err: unknown): void {
    if (this.events && this.events.listenerCount("error") > 0) {
      this.events.emit("error", err);
    }
  }
}
