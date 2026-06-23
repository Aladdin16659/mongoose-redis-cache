import type { DependencyIndex, QueryMeta } from "./DependencyIndex.js";
import { matches, type Doc } from "./PredicateMatcher.js";
import { idToString } from "../utils/id.js";

export interface WriteReport {
  invalidatedQueryKeys: string[];
}

/**
 * Drives precise (T1) invalidation via the membership-transition algorithm
 * (see plan.md "On write"). Given the before- and after-images of a changed
 * document, it determines exactly which cached queries could have changed.
 */
export class InvalidationEngine {
  constructor(private readonly index: DependencyIndex) {}

  async registerQuery(
    model: string,
    queryKey: string,
    meta: QueryMeta,
  ): Promise<void> {
    await this.index.addQuery(model, queryKey, meta);
  }

  async onWrite(
    model: string,
    before: Doc | null,
    after: Doc | null,
  ): Promise<WriteReport> {
    const docId = idToString((after ?? before)?._id);
    const queries = await this.index.getQueries(model);
    const invalidated: string[] = [];

    for (const q of queries) {
      // Step 2 — direct membership: the changed doc was in this result set.
      const directHit = docId !== undefined && q.resultDocIds.includes(docId);

      // Steps 3/4 — entering/leaving the predicate's result set.
      const wasMatch = before !== null && matches(q.predicate, before);
      const nowMatch = after !== null && matches(q.predicate, after);
      const transition = wasMatch !== nowMatch;

      // Step 5 — top-N safety: for a limited query we cannot cheaply know rank,
      // so any match (before or after) is a potential change to the window.
      const limitedHit = q.limited && (wasMatch || nowMatch);

      if (directHit || transition || limitedHit) {
        invalidated.push(q.queryKey);
        await this.index.removeQuery(model, q.queryKey);
      }
    }

    return { invalidatedQueryKeys: invalidated };
  }

  /**
   * Remove every registered query for a model and return their cache keys.
   * Used as a conservative fallback (bulkWrite, upserts) where per-document
   * before/after images aren't available.
   */
  async clearQueries(model: string): Promise<string[]> {
    return this.index.clearModel(model);
  }
}
