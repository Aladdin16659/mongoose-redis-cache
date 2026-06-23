import { stableHash } from "../utils/hash.js";

/**
 * Deterministic cache-key construction. Keys are namespaced by tenant (for
 * isolation), kind (`q` for query results, `doc` for point reads), and model.
 */
export interface CacheKeyInput {
  model: string;
  op: string;
  filter?: unknown;
  projection?: unknown;
  sort?: unknown;
  skip?: number | undefined;
  limit?: number | undefined;
  populate?: unknown;
  collation?: unknown;
  /** The field name for a `distinct` query (so distinct('a') ≠ distinct('b')). */
  distinct?: unknown;
  tenant?: string | undefined;
  schemaVersion?: string | undefined;
}

function tenantPrefix(tenant?: string): string {
  return tenant ? `tenant:${tenant}:` : "";
}

export function buildQueryKey(input: CacheKeyInput): string {
  // Everything that can change the result set feeds the hash.
  const hash = stableHash({
    op: input.op,
    filter: input.filter ?? null,
    projection: input.projection ?? null,
    sort: input.sort ?? null,
    skip: input.skip ?? null,
    limit: input.limit ?? null,
    populate: input.populate ?? null,
    collation: input.collation ?? null,
    distinct: input.distinct ?? null,
    schemaVersion: input.schemaVersion ?? null,
  });
  return `${tenantPrefix(input.tenant)}q:${input.model}:${hash}`;
}

export function buildDocKey(model: string, id: string, tenant?: string): string {
  return `${tenantPrefix(tenant)}doc:${model}:${id}`;
}

/**
 * Collection tag key. Tags are intentionally NOT tenant-scoped: a write to a
 * collection must invalidate the conservative (T2/T3) entries of every tenant
 * that touched it, so all tenants share one tag per collection.
 */
export function buildTagKey(collection: string): string {
  return `tag:coll:${collection}`;
}

export function buildAggregateKey(
  model: string,
  pipeline: unknown,
  tenant?: string,
): string {
  return `${tenantPrefix(tenant)}agg:${model}:${stableHash(pipeline)}`;
}
