/**
 * IR hashing. Two hashes:
 *  - serialized: sha256 over the canonical JSON of the whole program (includes
 *    provenance). Two byte-identical serializations hash identically.
 *  - semantic: sha256 over the program with provenance (`origin`) stripped, so
 *    programs that differ only in source spans/mnemonics hash the same.
 */
import { createHash } from "crypto";
import { canonicalJson } from "../contracts/hash";
import type { CanonicalProgram } from "./project";

function stripProvenance(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripProvenance);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "origin") continue; // provenance is not semantic identity
      out[k] = stripProvenance(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function serializedHash(program: CanonicalProgram): string {
  return sha256Hex(canonicalJson(program));
}

export function semanticHash(program: CanonicalProgram): string {
  return sha256Hex(canonicalJson(stripProvenance(program)));
}
