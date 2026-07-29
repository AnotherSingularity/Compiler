/**
 * Canonical PLC IR — Phase 2 forward-declaration stub.
 *
 * Phase 3 replaces the bodies here with the full node model (program structure,
 * types, expressions, statements). For now these are the minimum shapes the
 * plugin interfaces need to reference. The `irSchemaVersion` is authoritative
 * and carried on every program (invariant G).
 *
 * IMPORTANT: nothing serialized here may contain emitter callbacks, class
 * instances, or functions — IR must be plain data (invariant E/G).
 */
import type { LanguageId } from "./ids";

/**
 * A canonical compilation unit. Phase 3 fleshes out `body`/`declarations`.
 * The `raw` slot is a transitional carrier for the legacy source AST during
 * migration (Phase 5); it is NOT part of the serialized IR contract and is
 * dropped once normalization is complete.
 */
export interface CanonicalProgram {
  irSchemaVersion: string;
  sourceLanguage: LanguageId;
  /** Named units (programs/routines/functions/FBs). Expanded in Phase 3. */
  units: CanonicalUnitRef[];
  /** Transitional legacy carrier (Phase 5 only; never serialized as contract). */
  raw?: unknown;
}

export interface CanonicalUnitRef {
  id: string;
  name: string;
  kind: "program" | "routine" | "function" | "function_block" | "unknown";
}

/** Output of a backend's target-lowering pass (Phase 3+/5). */
export interface LoweredProgram {
  irSchemaVersion: string;
  targetLanguage: LanguageId;
  units: CanonicalUnitRef[];
  raw?: unknown;
}
