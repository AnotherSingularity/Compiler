/**
 * Canonical declaration emission (the `declarations` family).
 *
 * Emits VAR sections from canonical variable declarations with PRIMITIVE types
 * only. Array/structure/opaque/unresolved/FB-instance declarations belong to the
 * `arrays_structures` / other families and are handled by `canonicalDeclType`
 * returning null (routing keeps those on the legacy engine).
 */
import type { CanonicalType } from "../ir/types";
import type { CanonicalVariableDeclaration, VariableDirection } from "../ir/declarations";
import { emitExpression, type StEmitTarget } from "./st-emitter";

const INT_NAME: Record<string, string> = {
  "8:true": "SINT", "8:false": "USINT",
  "16:true": "INT", "16:false": "UINT",
  "32:true": "DINT", "32:false": "UDINT",
  "64:true": "LINT", "64:false": "ULINT",
};

/** ST spelling for a PRIMITIVE canonical type, or null if not a plain primitive. */
export function canonicalDeclType(t: CanonicalType): string | null {
  switch (t.kind) {
    case "boolean": return "BOOL";
    case "integer": return INT_NAME[`${t.bits}:${t.signed}`] ?? null;
    case "real": return t.bits === 64 ? "LREAL" : "REAL";
    case "time": return "TIME";
    case "string": return t.capacity ? `STRING[${t.capacity}]` : "STRING";
    default: return null; // array / structure / alias / fb / opaque / unresolved
  }
}

/** True if every declaration is a plain primitive (i.e. the declarations family). */
export function declsAreCanonical(decls: CanonicalVariableDeclaration[]): boolean {
  return decls.every((d) => canonicalDeclType(d.type) !== null);
}

const SECTION: Record<VariableDirection, string> = {
  input: "VAR_INPUT", output: "VAR_OUTPUT", in_out: "VAR_IN_OUT",
  local: "VAR", global: "VAR_GLOBAL", external: "VAR_EXTERNAL", temp: "VAR_TEMP",
};

/** Emit VAR sections (grouped by direction, deterministic order). */
export function emitDeclarations(decls: CanonicalVariableDeclaration[], t: StEmitTarget): string[] {
  if (decls.length === 0) return [];
  const order: VariableDirection[] = ["input", "output", "in_out", "local", "global", "external", "temp"];
  const lines: string[] = [];
  for (const dir of order) {
    const group = decls.filter((d) => d.direction === dir);
    if (group.length === 0) continue;
    lines.push(`${SECTION[dir]}`);
    for (const d of group) {
      const ty = canonicalDeclType(d.type)!;
      const init = d.initial ? ` := ${emitExpression(d.initial, t)}` : "";
      lines.push(`  ${d.name} : ${ty}${init};`);
    }
    lines.push("END_VAR");
  }
  return lines;
}
