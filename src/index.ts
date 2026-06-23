// Public surface (Phase 1 core).

export {
  createCache,
  type Cache,
  type CreateCacheOptions,
  type ModelConfig,
} from "./plugins/createCache.js";
export { RedisCacheStore } from "./cache/RedisCacheStore.js";
export { RedisDependencyIndex } from "./invalidation/RedisDependencyIndex.js";

export { normalizeQuery } from "./cache/fingerprint.js";
export { stableHash } from "./utils/hash.js";
export {
  buildQueryKey,
  buildDocKey,
  type CacheKeyInput,
} from "./cache/CacheKey.js";
export { serialize, deserialize } from "./cache/Serializer.js";
export {
  CacheManager,
  type CachedQuery,
} from "./cache/CacheManager.js";
export {
  type CacheStore,
  InMemoryCacheStore,
} from "./cache/CacheStore.js";

export {
  matches,
  isSupportedPredicate,
  type Filter,
  type Doc,
} from "./invalidation/PredicateMatcher.js";
export {
  classifyQuery,
  type Tier,
  type ClassifyInput,
} from "./invalidation/TierClassifier.js";
export {
  InvalidationEngine,
  type WriteReport,
} from "./invalidation/InvalidationEngine.js";
export {
  type DependencyIndex,
  InMemoryDependencyIndex,
  type QueryMeta,
  type RegisteredQuery,
} from "./invalidation/DependencyIndex.js";
