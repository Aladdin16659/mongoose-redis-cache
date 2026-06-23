import type { Redis } from "ioredis";
import type { DependencyIndex, QueryMeta, RegisteredQuery } from "./DependencyIndex.js";
import { serialize, deserialize } from "../cache/Serializer.js";

/**
 * Redis-backed {@link DependencyIndex}. Persisting the registry alongside the
 * cached entries themselves is a correctness requirement: if the registry were
 * only in-process, a restart would orphan still-cached query results — a later
 * write could no longer find them to invalidate, serving stale data.
 *
 * Predicate metadata is stored as BSON (not JSON) so ObjectId/Date values
 * inside a predicate survive the round-trip and the matcher stays accurate.
 */
export class RedisDependencyIndex implements DependencyIndex {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "idx:",
  ) {}

  async addQuery(model: string, queryKey: string, meta: QueryMeta): Promise<void> {
    await this.redis.sadd(this.setKey(model), queryKey);
    await this.redis.set(this.metaKey(model, queryKey), serialize(meta));
  }

  async removeQuery(model: string, queryKey: string): Promise<void> {
    await this.redis.srem(this.setKey(model), queryKey);
    await this.redis.del(this.metaKey(model, queryKey));
  }

  async getQueries(model: string): Promise<RegisteredQuery[]> {
    const queryKeys = await this.redis.smembers(this.setKey(model));
    const queries: RegisteredQuery[] = [];
    for (const queryKey of queryKeys) {
      const raw = await this.redis.getBuffer(this.metaKey(model, queryKey));
      if (raw === null) continue; // meta expired/removed — skip
      const meta = deserialize(raw) as QueryMeta;
      queries.push({ queryKey, ...meta });
    }
    return queries;
  }

  async clearModel(model: string): Promise<string[]> {
    const queryKeys = await this.redis.smembers(this.setKey(model));
    if (queryKeys.length === 0) return [];
    await this.redis.del(
      this.setKey(model),
      ...queryKeys.map((qk) => this.metaKey(model, qk)),
    );
    return queryKeys;
  }

  private setKey(model: string): string {
    return `${this.prefix}qset:${model}`;
  }

  private metaKey(model: string, queryKey: string): string {
    return `${this.prefix}qmeta:${model}:${queryKey}`;
  }
}
