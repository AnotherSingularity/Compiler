/**
 * Explicit conversion analysis.
 *
 * `classifyConversion(from, to)` assigns a `ConversionSafety` to a value moving
 * from one canonical type to another. This is the authoritative safety judgment
 * used when the compiler makes an implicit widening/narrowing explicit, or when
 * a source conversion function (e.g. `DINT_TO_REAL`) is lowered.
 *
 * It is deterministic and conservative: any pair it cannot prove safe is
 * reported honestly (`vendor_defined`/`reinterpretation`/`invalid`), never
 * silently treated as identity. Unresolved operands yield `vendor_defined`
 * (unknown safety) — callers must not manufacture a conversion node in that
 * case; they should record a semantic loss instead.
 */
import type { ConversionSafety } from "../ir/expressions";
import type { CanonicalType, IntegerType, RealType } from "../ir/types";
import { isInteger, isReal, realBits, typeEquals } from "./types";

/** Largest exactly-representable integer magnitude (bits) for a real width. */
function exactIntBitsForReal(realWidth: number): number {
  // IEEE754: 24-bit significand (single) → integers up to 2^24 exact;
  // 53-bit significand (double) → up to 2^53 exact.
  return realWidth >= 64 ? 53 : 24;
}

export function classifyConversion(from: CanonicalType, to: CanonicalType): ConversionSafety {
  if (from.kind === "unresolved" || to.kind === "unresolved") return "vendor_defined";
  if (typeEquals(from, to)) return "identity";

  // integer → integer
  if (isInteger(from) && isInteger(to)) return classifyIntToInt(from, to);

  // integer → real
  if (isInteger(from) && isReal(to)) {
    return from.bits <= exactIntBitsForReal(realBits(to)) ? "widening" : "precision_loss";
  }
  // real → integer (truncates fractional part)
  if (isReal(from) && isInteger(to)) return "narrowing";

  // real → real
  if (isReal(from) && isReal(to)) {
    return realBits(to) >= realBits(from) ? "widening" : "precision_loss";
  }

  // boolean ↔ integer: bit reinterpretation (0/1)
  if ((from.kind === "boolean" && isInteger(to)) || (isInteger(from) && to.kind === "boolean")) {
    return "reinterpretation";
  }

  // time ↔ integer (milliseconds): vendor-defined encoding, not portable-safe
  if ((from.kind === "time" && isInteger(to)) || (isInteger(from) && to.kind === "time")) {
    return "vendor_defined";
  }

  // Anything crossing into/out of string, structure, array, enum, etc. that is
  // not the identity is not a value-preserving numeric conversion.
  if (from.kind === "string" || to.kind === "string") return "vendor_defined";
  return "invalid";
}

function classifyIntToInt(from: IntegerType, to: IntegerType): ConversionSafety {
  if (from.signed === to.signed) {
    if (to.bits > from.bits) return "widening";
    if (to.bits < from.bits) return "narrowing";
    return "identity"; // same bits + signedness (typeEquals already caught, defensive)
  }
  // Signedness changes. Widening a same-or-larger container still reinterprets
  // the sign bit range, so it is a signedness change, not a clean widening.
  if (to.bits < from.bits) return "narrowing";
  return "signedness_change";
}
