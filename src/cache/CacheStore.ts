/**
 * Storage contract used by the CacheManager. The in-memory implementation is
 * the reference (and powers unit tests); a Redis-backed adapter (Phase 2)
 * implements the same contract with Lua scripts for the atomic version guard.
 *
 * The per-model version counter underpins the write-after-read race guard:
 * a reader captures the version before loading from Mongo and only writes the
 * value to cache if no write bumped the version meanwhile.
 */
export interface CacheStore {
  get(key: string): Promise<Buffer | null>;
  set(key: string, value: Buffer, ttlMs?: number): Promise<void>;
  del(keys: string[]): Promise<void>;
  getVersion(model: string): Promise<number>;
  bumpVersion(model: string): Promise<number>;
  /** Tag membership — backs conservative (collection-tag) invalidation. */
  addToSet(setKey: string, member: string): Promise<void>;
  /** Return all members of a set and delete the set (atomic drain). */
  drainSet(setKey: string): Promise<string[]>;
}

export class InMemoryCacheStore implements CacheStore {
  private readonly data = new Map<string, Buffer>();
  private readonly versions = new Map<string, number>();
  private readonly sets = new Map<string, Set<string>>();

  async get(key: string): Promise<Buffer | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: Buffer, _ttlMs?: number): Promise<void> {
    this.data.set(key, value);
  }

  async del(keys: string[]): Promise<void> {
    for (const key of keys) this.data.delete(key);
  }

  async getVersion(model: string): Promise<number> {
    return this.versions.get(model) ?? 0;
  }

  async bumpVersion(model: string): Promise<number> {
    const next = (this.versions.get(model) ?? 0) + 1;
    this.versions.set(model, next);
    return next;
  }

  async addToSet(setKey: string, member: string): Promise<void> {
    let set = this.sets.get(setKey);
    if (!set) {
      set = new Set();
      this.sets.set(setKey, set);
    }
    set.add(member);
  }

  async drainSet(setKey: string): Promise<string[]> {
    const set = this.sets.get(setKey);
    if (!set) return [];
    this.sets.delete(setKey);
    return [...set];
  }
}
