/**
 * Semantic type utilities (canonical type algebra).
 *
 * Pure, deterministic helpers over the canonical type model (`ir/types.ts`).
 * These NEVER fabricate a resolved type from an unresolved input: if an operand
 * type is `unresolved`, every derived result is `unresolved` too. Guessing a
 * type here would silently launder an unknown into a concrete conversion later.
 */
import {
  type CanonicalType,
  type IntegerType,
  type RealType,
  int,
  REAL32,
  REAL64,
  unresolvedType,
} from "../ir/types";

export function isUnresolved(t: CanonicalType): boolean {
  return t.kind === "unresolved";
}
export function isInteger(t: CanonicalType): t is IntegerType {
  return t.kind === "integer";
}
export function isReal(t: CanonicalType): t is RealType {
  return t.kind === "real";
}
export function isNumeric(t: CanonicalType): boolean {
  return t.kind === "integer" || t.kind === "real";
}

export function realBits(t: RealType): number {
  return t.bits ?? 32;
}

/** Structural equality of two canonical types (ignoring `sourceSpelling`). */
export function typeEquals(a: CanonicalType, b: CanonicalType): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "integer": {
      const y = b as IntegerType;
      return a.signed === y.signed && a.bits === y.bits;
    }
    case "real":
      return realBits(a) === realBits(b as RealType);
    case "boolean":
    case "time":
    case "date":
    case "datetime":
      return true;
    case "string": {
      const y = b as { capacity?: number; wide?: boolean };
      return (a.capacity ?? -1) === (y.capacity ?? -1) && !!a.wide === !!y.wide;
    }
    case "array": {
      const y = b as import("../ir/types").ArrayType;
      return (
        a.dimensions.length === y.dimensions.length &&
        a.dimensions.every((d, i) => d.lower === y.dimensions[i].lower && d.upper === y.dimensions[i].upper) &&
        typeEquals(a.element, y.element)
      );
    }
    case "structure":
    case "enumeration":
    case "alias":
      return (a as { name: string }).name === (b as { name: string }).name;
    case "function_block_instance":
      return a.fbTypeName === (b as import("../ir/types").FunctionBlockInstanceType).fbTypeName;
    case "unresolved":
      return (a.name ?? "") === ((b as import("../ir/types").UnresolvedType).name ?? "");
    default:
      return false;
  }
}

/**
 * Result type of a binary arithmetic operator (`+ - * / mod pow`) on two
 * operand types. Principled canonical promotion:
 *   - either operand unresolved      → unresolved (never guessed)
 *   - either operand real            → real, wider of the two real widths (>=32)
 *   - both integer                   → integer, wider bit width; signed if either
 *                                      operand is signed (a signed operand can
 *                                      carry a value the unsigned type cannot)
 *   - anything else (bool/string/…)  → unresolved (no silent coercion)
 * Division of two integers stays integer here (ST integer division); a REAL
 * result requires an explicit conversion in the source, which we honor via the
 * operand types.
 */
export function arithmeticResultType(l: CanonicalType, r: CanonicalType): CanonicalType {
  if (isUnresolved(l) || isUnresolved(r)) return unresolvedType(undefined, "operand type unresolved");
  if (isReal(l) || isReal(r)) {
    const bits = Math.max(isReal(l) ? realBits(l) : 32, isReal(r) ? realBits(r) : 32);
    return bits >= 64 ? REAL64 : REAL32;
  }
  if (isInteger(l) && isInteger(r)) {
    return int(Math.max(l.bits, r.bits), l.signed || r.signed);
  }
  return unresolvedType(undefined, "non-numeric arithmetic operand");
}
