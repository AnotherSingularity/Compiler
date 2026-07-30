/**
 * Deterministic scope + symbol resolution.
 *
 * A `Scope` is an immutable name→symbol table with an optional parent. Structured
 * Text identifiers are case-insensitive, so lookups key on the upper-cased name
 * while the original spelling is preserved on the entry (emission never changes
 * spelling). Scope construction is order-independent and deterministic: the same
 * program always yields the same symbol ids and types.
 *
 * Symbol ids are the declaring node's canonical id (structural, content-derived)
 * — a stable, program-wide-unique handle we never invent from a name.
 */
import type { CanonicalType } from "../ir/types";
import type { VariableDirection, CanonicalVariableDeclaration, CanonicalParameter } from "../ir/declarations";
import type { CanonicalProgram } from "../ir/project";
import { int } from "../ir/types";

export type SymbolKind = "variable" | "parameter" | "loop_index" | "instance";

export interface SymbolEntry {
  /** Original declared spelling. */
  name: string;
  /** Stable id: the declaring node's canonical id, or a synthetic scope id. */
  symbolId: string;
  type: CanonicalType;
  direction: VariableDirection;
  kind: SymbolKind;
}

export class Scope {
  private readonly table = new Map<string, SymbolEntry>();
  constructor(public readonly parent: Scope | null = null) {}

  /** Define a symbol. Last definition in the same scope wins (deterministic by insertion order). */
  define(entry: SymbolEntry): void {
    this.table.set(entry.name.toUpperCase(), entry);
  }

  /** Case-insensitive lookup through the parent chain. */
  resolve(name: string): SymbolEntry | undefined {
    const key = name.toUpperCase();
    for (let s: Scope | null = this; s; s = s.parent) {
      const hit = s.table.get(key);
      if (hit) return hit;
    }
    return undefined;
  }

  /** Own entries (not parent), in insertion order. */
  ownEntries(): SymbolEntry[] {
    return [...this.table.values()];
  }
}

function entryOfVar(v: CanonicalVariableDeclaration): SymbolEntry {
  return { name: v.name, symbolId: v.id, type: v.type, direction: v.direction, kind: "variable" };
}
function entryOfParam(p: CanonicalParameter, ownerId: string, index: number): SymbolEntry {
  return { name: p.name, symbolId: `${ownerId}/param[${index}]`, type: p.type, direction: p.direction, kind: "parameter" };
}

/** Program-level scope: globals (and program-scoped declarations). */
export function buildProgramScope(program: CanonicalProgram): Scope {
  const scope = new Scope(null);
  for (const g of program.globals) scope.define(entryOfVar(g));
  return scope;
}

/**
 * Routine scope: locals layered over the program scope. A FOR loop index that is
 * not otherwise declared is registered as an implicit DINT loop index (IEC ST
 * default control-variable type) so it resolves rather than dangling — recorded
 * with kind `loop_index` so downstream passes can tell it apart from a real decl.
 */
export function buildRoutineScope(
  parent: Scope,
  locals: CanonicalVariableDeclaration[],
  ownerId: string,
  parameters: CanonicalParameter[] = [],
): Scope {
  const scope = new Scope(parent);
  parameters.forEach((p, i) => scope.define(entryOfParam(p, ownerId, i)));
  for (const v of locals) scope.define(entryOfVar(v));
  return scope;
}

/** Register a FOR-loop control variable if it is not already in scope. */
export function withLoopIndex(scope: Scope, variable: string, ownerPath: string): Scope {
  if (scope.resolve(variable)) return scope;
  const child = new Scope(scope);
  child.define({
    name: variable,
    symbolId: `${ownerPath}/loop[${variable}]`,
    type: int(32, true),
    direction: "temp",
    kind: "loop_index",
  });
  return child;
}
