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
import type { MigrationFamily } from "../migration/families";
import { emitDeclTypeSpelling } from "../ir/decl-types";
import { emitExpression, type StEmitTarget } from "./st-emitter";

/** ST spelling for an emittable canonical declaration type (primitive or array), or null. */
export function canonicalDeclType(t: CanonicalType): string | null {
  return emitDeclTypeSpelling(t);
}

/** Migration family a declaration type belongs to (primitive → declarations, array → arrays_structures). */
export function declFamilyOf(t: CanonicalType): MigrationFamily | null {
  if (t.kind === "array" || t.kind === "structure") return "arrays_structures";
  return emitDeclTypeSpelling(t) !== null ? "declarations" : null;
}

/**
 * True if every declaration is canonically emittable AND its family is active.
 * `isActive` defaults to treating every family as active (emitter-support check);
 * routing passes the registry so array declarations require `arrays_structures`.
 */
export function declsAreCanonical(
  decls: CanonicalVariableDeclaration[],
  isActive: (f: MigrationFamily) => boolean = () => true,
): boolean {
  return decls.every((d) => {
    if (emitDeclTypeSpelling(d.type) === null) return false;
    const fam = declFamilyOf(d.type);
    return fam !== null && isActive(fam);
  });
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
