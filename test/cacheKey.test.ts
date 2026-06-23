import { describe, expect, test } from "vitest";
import { stableHash } from "../src/utils/hash.js";
import { buildDocKey, buildQueryKey } from "../src/cache/CacheKey.js";

describe("stableHash", () => {
  test("is deterministic for equal inputs regardless of key order", () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
  });

  test("differs for different inputs", () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });

  test("returns a hex string", () => {
    expect(stableHash({ a: 1 })).toMatch(/^[0-9a-f]+$/);
  });
});

describe("buildQueryKey", () => {
  const base = { model: "User", op: "find" as const };

  test("equal logical queries produce the same key", () => {
    const k1 = buildQueryKey({ ...base, filter: { a: 1, b: 2 } });
    const k2 = buildQueryKey({ ...base, filter: { b: 2, a: 1 } });
    expect(k1).toBe(k2);
  });

  test("different filters produce different keys", () => {
    const k1 = buildQueryKey({ ...base, filter: { a: 1 } });
    const k2 = buildQueryKey({ ...base, filter: { a: 2 } });
    expect(k1).not.toBe(k2);
  });

  test("different ops produce different keys", () => {
    const k1 = buildQueryKey({ ...base, op: "find", filter: { a: 1 } });
    const k2 = buildQueryKey({ ...base, op: "findOne", filter: { a: 1 } });
    expect(k1).not.toBe(k2);
  });

  test("different models produce different keys", () => {
    const k1 = buildQueryKey({ model: "User", op: "find", filter: { a: 1 } });
    const k2 = buildQueryKey({ model: "Post", op: "find", filter: { a: 1 } });
    expect(k1).not.toBe(k2);
  });

  test("includes the model namespace and query kind", () => {
    const k = buildQueryKey({ ...base, filter: { a: 1 } });
    expect(k).toMatch(/q:User:/);
  });

  test("tenant is part of the key and isolates keyspaces", () => {
    const shared = { ...base, filter: { a: 1 } };
    const t5 = buildQueryKey({ ...shared, tenant: "5" });
    const t8 = buildQueryKey({ ...shared, tenant: "8" });
    const none = buildQueryKey(shared);
    expect(t5).not.toBe(t8);
    expect(t5).not.toBe(none);
    expect(t5).toContain("tenant:5:");
  });

  test("skip/limit/sort/projection affect the key", () => {
    const k0 = buildQueryKey({ ...base, filter: { a: 1 } });
    expect(buildQueryKey({ ...base, filter: { a: 1 }, limit: 10 })).not.toBe(k0);
    expect(buildQueryKey({ ...base, filter: { a: 1 }, skip: 5 })).not.toBe(k0);
    expect(buildQueryKey({ ...base, filter: { a: 1 }, sort: { a: 1 } })).not.toBe(k0);
    expect(
      buildQueryKey({ ...base, filter: { a: 1 }, projection: { a: 1 } }),
    ).not.toBe(k0);
  });
});

describe("buildDocKey", () => {
  test("formats as doc:<model>:<id>", () => {
    expect(buildDocKey("User", "abc")).toBe("doc:User:abc");
  });

  test("includes tenant prefix when present", () => {
    expect(buildDocKey("User", "abc", "5")).toBe("tenant:5:doc:User:abc");
  });
});
