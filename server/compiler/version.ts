/**
 * Versioned contract constants.
 *
 * Determinism (invariant E): identical source bytes + identical versions +
 * identical options must yield identical IR, artifacts, diagnostics, and hashes.
 * These constants are bumped deliberately, never as an incidental side effect.
 */

/** Compiler platform version (the build-out, distinct from the app package version). */
export const COMPILER_VERSION = "0.1.0";

/**
 * Canonical PLC IR schema version. The IR itself arrives in Phase 3; this
 * constant is reserved now so serialized contracts never depend on an
 * unversioned object (invariant G).
 */
export const IR_SCHEMA_VERSION = "1.0.0";
