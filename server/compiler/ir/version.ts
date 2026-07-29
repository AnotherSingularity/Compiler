/**
 * Canonical PLC IR schema version.
 *
 * Bumped deliberately. `1.x` additions must remain backward-readable; a
 * breaking change requires a `2.0.0` bump and an explicit upgrade step
 * (see upgrade.ts). Never silently reinterpret an incompatible schema.
 */
export const IR_SCHEMA_VERSION = "1.0.0";
export const IR_SCHEMA_TAG = "plc-canonical-ir" as const;
