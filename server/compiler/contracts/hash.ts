/**
 * Deterministic serialization + hashing (invariant E).
 *
 * `canonicalJson` produces byte-stable JSON with object keys sorted
 * recursively, so equal logical values hash equally regardless of key order.
 * Timestamps and other non-deterministic fields must be excluded by the caller
 * before hashing.
 */
import { createHash } from "crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue; // undefined is not JSON; drop for stability
      out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Hash any JSON-serializable value via its canonical form. */
export function hashValue(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
