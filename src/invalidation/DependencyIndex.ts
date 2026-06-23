import type { Filter } from "./PredicateMatcher.js";

/**
 * Metadata recorded for every cached T1 query so that a later write can decide,
 * precisely, whether the query's result set could have changed.
 */
export interface QueryMeta {
  predicate: Filter;
  /** True when the query has a limit (top-N) — see InvalidationEngine step 5. */
  limited: boolean;
  /** Stable string ids of the documents currently in the cached result. */
  resultDocIds: string[];
}

export interface RegisteredQuery extends QueryMeta {
  queryKey: string;
}

/**
 * Index of active T1 queries, keyed by model. The in-memory implementation is
 * the source of truth for unit tests and single-process use; a Redis-backed
 * implementation (Phase 2) provides the same contract across nodes.
 */
export interface DependencyIndex {
  addQuery(model: string, queryKey: string, meta: QueryMeta): Promise<void>;
  removeQuery(model: string, queryKey: string): Promise<void>;
  getQueries(model: string): Promise<RegisteredQuery[]>;
  /** Remove every registered query for a model, returning the keys removed. */
  clearModel(model: string): Promise<string[]>;
}

export class InMemoryDependencyIndex implements DependencyIndex {
  private readonly byModel = new Map<string, Map<string, QueryMeta>>();

  async addQuery(model: string, queryKey: string, meta: QueryMeta): Promise<void> {
    let queries = this.byModel.get(model);
    if (!queries) {
      queries = new Map();
      this.byModel.set(model, queries);
    }
    queries.set(queryKey, meta);
  }

  async removeQuery(model: string, queryKey: string): Promise<void> {
    this.byModel.get(model)?.delete(queryKey);
  }

  async getQueries(model: string): Promise<RegisteredQuery[]> {
    const queries = this.byModel.get(model);
    if (!queries) return [];
    return [...queries.entries()].map(([queryKey, meta]) => ({
      queryKey,
      ...meta,
    }));
  }

  async clearModel(model: string): Promise<string[]> {
    const queries = this.byModel.get(model);
    if (!queries) return [];
    const keys = [...queries.keys()];
    this.byModel.delete(model);
    return keys;
  }
}
