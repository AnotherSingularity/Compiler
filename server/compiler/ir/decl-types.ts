/**
 * Declaration type parsing + spelling (shared by the IR normalizer and the
 * canonical declaration emitter so the two never drift).
 *
 * Handles the type forms the ST parser can produce as a declaration type string:
 * primitives and one-or-multi-dimensional arrays of primitives. Structures/UDTs
 * are not declarable in ST source (they arrive via the L5K project model), so an
 * unrecognized spelling yields an `unresolved` type — never a guess.
 */
import { BOOL, REAL32, REAL64, int, unresolvedType, type CanonicalType, type ArrayType } from "./types";

/**
 * Primitive IEC spelling → canonical type. No `sourceSpelling` is attached here:
 * declaration types round-trip through their canonical bits/signedness (the
 * emitter derives the spelling), and keeping resolved types spelling-free keeps
 * type identity clean. (Conversion FROM/TO types attach their own spellings.)
 */
export function parsePrimitiveType(spelling: string): CanonicalType | null {
  switch (spelling.trim().toUpperCase()) {
    case "BOOL": return BOOL;
    case "SINT": return int(8, true);
    case "USINT": case "BYTE": return int(8, false);
    case "INT": return int(16, true);
    case "UINT": case "WORD": return int(16, false);
    case "DINT": return int(32, true);
    case "UDINT": case "DWORD": return int(32, false);
    case "LINT": return int(64, true);
    case "ULINT": case "LWORD": return int(64, false);
    case "REAL": return REAL32;
    case "LREAL": return REAL64;
    case "TIME": return { kind: "time" };
    case "STRING": return { kind: "string" };
    default: return null;
  }
}

const ARRAY_RE = /^ARRAY\s*\[([^\]]+)\]\s+OF\s+(.+)$/i;

/** Parse `ARRAY[lo..hi, ...] OF ELEM` into an ArrayType, or null if not a (primitive-element) array. */
export function parseArrayType(spelling: string): ArrayType | null {
  const m = spelling.trim().match(ARRAY_RE);
  if (!m) return null;
  const dims = m[1].split(",").map((d) => d.trim());
  const dimensions = [];
  for (const d of dims) {
    const parts = d.split("..");
    if (parts.length !== 2) return null;
    const lower = Number(parts[0].trim());
    const upper = Number(parts[1].trim());
    if (!Number.isInteger(lower) || !Number.isInteger(upper) || upper < lower) return null;
    dimensions.push({ lower, upper, inferred: false });
  }
  const element = parsePrimitiveType(m[2]);
  if (!element) return null; // nested arrays / UDT elements → not canonical (legacy)
  return { kind: "array", element, dimensions, sourceSpelling: spelling.trim() };
}

/** Parse any declaration type string: primitive, array, else unresolved (never guessed). */
export function parseDeclType(spelling: string): CanonicalType {
  return parsePrimitiveType(spelling) ?? parseArrayType(spelling) ?? unresolvedType(spelling);
}

/** ST spelling for a canonical PRIMITIVE type, or null if not a plain primitive. */
export function primitiveSpelling(t: CanonicalType): string | null {
  switch (t.kind) {
    case "boolean": return "BOOL";
    case "integer": {
      const m: Record<string, string> = { "8:true": "SINT", "8:false": "USINT", "16:true": "INT", "16:false": "UINT", "32:true": "DINT", "32:false": "UDINT", "64:true": "LINT", "64:false": "ULINT" };
      return m[`${t.bits}:${t.signed}`] ?? null;
    }
    case "real": return t.bits === 64 ? "LREAL" : "REAL";
    case "time": return "TIME";
    case "string": return t.capacity ? `STRING[${t.capacity}]` : "STRING";
    default: return null;
  }
}

/**
 * ST spelling for an emittable declaration type (primitive or array-of-primitive),
 * or null when the type belongs to a not-yet-canonical family (structure/UDT/
 * unresolved). Array bounds are PRESERVED exactly (no silent rebasing).
 */
export function emitDeclTypeSpelling(t: CanonicalType): string | null {
  const prim = primitiveSpelling(t);
  if (prim) return prim;
  if (t.kind === "array") {
    const elem = primitiveSpelling((t as ArrayType).element);
    if (!elem) return null;
    const dims = (t as ArrayType).dimensions.map((d) => `${d.lower}..${d.upper}`).join(", ");
    return `ARRAY[${dims}] OF ${elem}`;
  }
  return null;
}
