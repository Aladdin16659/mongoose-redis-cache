import type { Redis } from "ioredis";
import type { CacheStore } from "./CacheStore.js";

/**
 * Redis-backed {@link CacheStore}. Implements the same contract proven against
 * the in-memory store, so all CacheManager correctness logic carries over.
 *
 * Phase 1 targets single-node correctness (in-process single-flight + a
 * per-model version counter). Phase 2 hardens the version guard into an atomic
 * Lua compare-and-set for multi-node deployments.
 */
export class RedisCacheStore implements CacheStore {
  constructor(
    private readonly redis: Redis,
    private readonly versionPrefix = "ver:",
  ) {}

  async get(key: string): Promise<Buffer | null> {
    // getBuffer preserves raw bytes — required for binary BSON payloads.
    return this.redis.getBuffer(key);
  }

  async set(key: string, value: Buffer, ttlMs?: number): Promise<void> {
    if (ttlMs !== undefined) {
      await this.redis.set(key, value, "PX", ttlMs);
    } else {
      await this.redis.set(key, value);
    }
  }

  async del(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.redis.del(...keys);
  }

  async getVersion(model: string): Promise<number> {
    const raw = await this.redis.get(this.versionKey(model));
    return raw === null ? 0 : Number(raw);
  }

  async bumpVersion(model: string): Promise<number> {
    return this.redis.incr(this.versionKey(model));
  }

  async addToSet(setKey: string, member: string): Promise<void> {
    await this.redis.sadd(setKey, member);
  }

  async drainSet(setKey: string): Promise<string[]> {
    const members = await this.redis.smembers(setKey);
    if (members.length > 0) await this.redis.del(setKey);
    return members;
  }

  private versionKey(model: string): string {
    return `${this.versionPrefix}${model}`;
  }
}
