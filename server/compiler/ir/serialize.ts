/**
 * Deterministic IR serialization + envelope handling.
 *
 * Serialized form is byte-stable for equivalent IR (canonical key ordering via
 * `canonicalJson`). Functions, class instances, and cycles are rejected before
 * serialization rather than silently dropped.
 */
import { canonicalJson } from "../contracts/hash";
import { IR_SCHEMA_VERSION, IR_SCHEMA_TAG } from "./version";
import { serializedHash, semanticHash } from "./hash";
import type { CanonicalProgram } from "./project";

export interface CanonicalIrEnvelope {
  schema: typeof IR_SCHEMA_TAG;
  schemaVersion: string;
  compilerVersion: string;
  program: CanonicalProgram;
  hashes: {
    semantic: string;
    serialized: string;
  };
}

export class IrSerializationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "IrSerializationError";
    this.code = code;
  }
}

/** Throw if `value` contains functions, class instances, or cycles. */
export function assertPlainData(value: unknown, path = "$", seen = new WeakSet<object>()): void {
  const t = typeof value;
  if (value === null || t === "string" || t === "number" || t === "boolean" || t === "undefined") return;
  if (t === "function") throw new IrSerializationError("IR_UNSUPPORTED_VALUE", `function at ${path}`);
  if (t === "bigint" || t === "symbol") throw new IrSerializationError("IR_UNSUPPORTED_VALUE", `${t} at ${path}`);
  if (t === "object") {
    const obj = value as object;
    if (seen.has(obj)) throw new IrSerializationError("IR_CYCLE", `cycle at ${path}`);
    seen.add(obj);
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => assertPlainData(v, `${path}[${i}]`, seen));
    } else {
      const proto = Object.getPrototypeOf(obj);
      if (proto !== Object.prototype && proto !== null) {
        throw new IrSerializationError("IR_UNSUPPORTED_VALUE", `class instance at ${path}`);
      }
      for (const [k, v] of Object.entries(obj)) assertPlainData(v, `${path}.${k}`, seen);
    }
    seen.delete(obj);
  }
}

export function buildEnvelope(program: CanonicalProgram, compilerVersion: string): CanonicalIrEnvelope {
  assertPlainData(program, "program");
  return {
    schema: IR_SCHEMA_TAG,
    schemaVersion: IR_SCHEMA_VERSION,
    compilerVersion,
    program,
    hashes: { semantic: semanticHash(program), serialized: serializedHash(program) },
  };
}

/** Deterministic canonical JSON of the whole envelope. */
export function serializeEnvelope(envelope: CanonicalIrEnvelope): string {
  return canonicalJson(envelope);
}

export function serializeProgram(program: CanonicalProgram, compilerVersion: string): string {
  return serializeEnvelope(buildEnvelope(program, compilerVersion));
}

export function parseEnvelope(json: string): CanonicalIrEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new IrSerializationError("IR_INVALID_JSON", (e as Error).message);
  }
  const env = parsed as Partial<CanonicalIrEnvelope>;
  if (!env || env.schema !== IR_SCHEMA_TAG) {
    throw new IrSerializationError("IR_INVALID_SCHEMA_TAG", `expected schema "${IR_SCHEMA_TAG}"`);
  }
  if (typeof env.schemaVersion !== "string") {
    throw new IrSerializationError("IR_INVALID_SCHEMA_VERSION", "missing schemaVersion");
  }
  // Upgrade check happens in upgrade.ts (imported by callers that want it).
  if (!env.program) {
    throw new IrSerializationError("IR_MISSING_PROGRAM", "envelope has no program");
  }
  return env as CanonicalIrEnvelope;
}
