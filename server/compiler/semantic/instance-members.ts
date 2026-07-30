/**
 * Canonical timer/counter instance + field modeling.
 *
 * Detects which identifiers are timer/counter instances (they appear as the
 * instance argument of a timer_/counter_ semantic operation) and rewrites member
 * accesses on them (T.DN, C.ACC) into canonical instance_field nodes carrying a
 * vendor-neutral field name (done, preset, accumulator). Vendor spellings live
 * only in the field maps; target emission re-spells them per target dialect
 * (AB .DN vs IEC .Q).
 *
 * A member whose field is not a recognized, cleanly-mappable instance field is
 * left as an ordinary member_access (the routing guard then keeps it on the
 * legacy engine) - never guessed.
 */
import type { LanguageId } from "../contracts/ids";
import type { Expression, InstanceFieldExpr } from "../ir/expressions";
import type {
  Statement, AssignmentStmt, ConditionalStmt, CaseStmt, ForStmt, WhileStmt, RepeatStmt,
} from "../ir/statements";
import type { SemanticOperationNode } from "../ir/operations";
import type { CanonicalProgram } from "../ir/project";
import type { CanonicalRoutine, CanonicalFunction, CanonicalFunctionBlock } from "../ir/declarations";
import { BOOL, int, type CanonicalType } from "../ir/types";

export type InstanceKind = "timer" | "counter";
export type CanonicalField =
  | "done" | "preset" | "accumulator" | "enabled" | "timing"
  | "count_up" | "count_down" | "overflow" | "underflow";

/** Vendor field spelling → canonical field, per instance kind (both AB and IEC spellings). */
const TIMER_FIELD_BY_SPELLING: Record<string, CanonicalField> = {
  DN: "done", Q: "done",
  PRE: "preset", PT: "preset",
  ACC: "accumulator", ET: "accumulator",
  EN: "enabled",
};
const COUNTER_FIELD_BY_SPELLING: Record<string, CanonicalField> = {
  DN: "done", Q: "done",
  PRE: "preset", PV: "preset",
  ACC: "accumulator", CV: "accumulator",
  CU: "count_up", CD: "count_down",
};

/** Canonical field → target dialect spelling. null = no clean target spelling (stay legacy). */
const TIMER_SPELLING: Record<LanguageId | "default", Partial<Record<CanonicalField, string>>> = {
  "mitsubishi-gx-st": { done: "Q", preset: "PT", accumulator: "ET", enabled: "EN" },
  "rockwell-logix-st": { done: "DN", preset: "PRE", accumulator: "ACC", enabled: "EN" },
  default: {},
} as Record<LanguageId | "default", Partial<Record<CanonicalField, string>>>;
const COUNTER_SPELLING: Record<LanguageId | "default", Partial<Record<CanonicalField, string>>> = {
  "mitsubishi-gx-st": { done: "Q", preset: "PV", accumulator: "CV", count_up: "CU", count_down: "CD" },
  "rockwell-logix-st": { done: "DN", preset: "PRE", accumulator: "ACC", count_up: "CU", count_down: "CD" },
  default: {},
} as Record<LanguageId | "default", Partial<Record<CanonicalField, string>>>;

/** Field data type (done/enabled are BOOL; preset/accumulator are DINT-ish). */
function fieldType(field: CanonicalField): CanonicalType {
  if (field === "done" || field === "enabled") return BOOL;
  if (field === "preset" || field === "accumulator") return int(32, true);
  return BOOL; // count_up/down/overflow/underflow are edge/status bits
}

export function canonicalFieldOf(spelling: string, kind: InstanceKind): CanonicalField | null {
  const map = kind === "timer" ? TIMER_FIELD_BY_SPELLING : COUNTER_FIELD_BY_SPELLING;
  return map[spelling.toUpperCase()] ?? null;
}

/** Target spelling for a canonical field, or null when the target has no clean equivalent. */
export function targetFieldSpelling(field: CanonicalField, kind: InstanceKind, target: LanguageId): string | null {
  const table = kind === "timer" ? TIMER_SPELLING : COUNTER_SPELLING;
  return (table[target] ?? table.default)[field] ?? null;
}

/** Collect timer/counter instance names (upper-cased) from a routine's operations. */
export function collectInstances(stmts: Statement[], out: Map<string, InstanceKind> = new Map()): Map<string, InstanceKind> {
  const visit = (s: Statement): void => {
    if (s.node === "semantic_operation") {
      const op = s as SemanticOperationNode;
      const kind: InstanceKind | null = op.operation.startsWith("timer_") ? "timer" : op.operation.startsWith("counter_") ? "counter" : null;
      if (kind) {
        const inst = op.args.find((a) => a.role === "timer" || a.role === "counter" || a.role === "arg0");
        if (inst && inst.value.node === "symbol_ref") out.set(inst.value.name.toUpperCase(), kind);
      }
    }
    childrenOf(s).forEach(visit);
  };
  stmts.forEach(visit);
  return out;
}

function childrenOf(s: Statement): Statement[] {
  switch (s.node) {
    case "conditional": return [...s.branches.flatMap((b) => b.body), ...(s.elseBody ?? [])];
    case "case": return [...s.branches.flatMap((b) => b.body), ...(s.elseBody ?? [])];
    case "for": case "while": case "repeat": return s.body;
    default: return [];
  }
}

// ── Rewrite member accesses on known instances into instance_field nodes ───
function rewriteExpr(expr: Expression, instances: Map<string, InstanceKind>, target: LanguageId): Expression {
  switch (expr.node) {
    case "member_access": {
      const obj = rewriteExpr(expr.object, instances, target);
      if (obj.node === "symbol_ref") {
        const kind = instances.get(obj.name.toUpperCase());
        if (kind) {
          const field = canonicalFieldOf(expr.member, kind);
          // Only lower when the field is recognized AND cleanly spellable on the target.
          if (field && targetFieldSpelling(field, kind, target)) {
            const node: InstanceFieldExpr = {
              node: "instance_field", id: expr.id, origin: expr.origin,
              instance: obj.name, field, instanceKind: kind, type: fieldType(field),
            };
            return node;
          }
        }
      }
      return { ...expr, object: obj };
    }
    case "array_access": return { ...expr, array: rewriteExpr(expr.array, instances, target), indices: expr.indices.map((i) => rewriteExpr(i, instances, target)) };
    case "unary": return { ...expr, operand: rewriteExpr(expr.operand, instances, target) };
    case "binary": case "comparison": case "logical": return { ...expr, left: rewriteExpr(expr.left, instances, target), right: rewriteExpr(expr.right, instances, target) };
    case "conversion": return { ...expr, operand: rewriteExpr(expr.operand, instances, target) };
    case "range": return { ...expr, low: rewriteExpr(expr.low, instances, target), high: rewriteExpr(expr.high, instances, target) };
    case "function_call": return { ...expr, args: expr.args.map((a) => rewriteExpr(a, instances, target)) };
    case "fb_invoke": return { ...expr, namedArgs: expr.namedArgs.map((a) => ({ ...a, value: rewriteExpr(a.value, instances, target) })) };
    default: return expr;
  }
}

function rewriteStmt(stmt: Statement, instances: Map<string, InstanceKind>, target: LanguageId): Statement {
  const e = (x: Expression) => rewriteExpr(x, instances, target);
  switch (stmt.node) {
    case "assignment": { const s = stmt as AssignmentStmt; return { ...s, target: e(s.target), value: e(s.value) }; }
    case "conditional": { const s = stmt as ConditionalStmt; return { ...s, branches: s.branches.map((b) => ({ condition: e(b.condition), body: b.body.map((x) => rewriteStmt(x, instances, target)) })), elseBody: s.elseBody ? s.elseBody.map((x) => rewriteStmt(x, instances, target)) : null }; }
    case "case": { const s = stmt as CaseStmt; return { ...s, selector: e(s.selector), branches: s.branches.map((b) => ({ labels: b.labels.map(e), body: b.body.map((x) => rewriteStmt(x, instances, target)) })), elseBody: s.elseBody ? s.elseBody.map((x) => rewriteStmt(x, instances, target)) : null }; }
    case "for": { const s = stmt as ForStmt; return { ...s, from: e(s.from), to: e(s.to), by: s.by ? e(s.by) : null, body: s.body.map((x) => rewriteStmt(x, instances, target)) }; }
    case "while": { const s = stmt as WhileStmt; return { ...s, condition: e(s.condition), body: s.body.map((x) => rewriteStmt(x, instances, target)) }; }
    case "repeat": { const s = stmt as RepeatStmt; return { ...s, body: s.body.map((x) => rewriteStmt(x, instances, target)), until: e(s.until) }; }
    case "call": {
      // Type-aware RES: resolve the operand kind from usage evidence (the
      // instance map, built from actual timer/counter operations) — NOT from the
      // operand name or the RES mnemonic. Unresolved operand → left as a call
      // (routes legacy / manual-port), never guessed.
      if (stmt.name.toUpperCase() === "RES" && stmt.args.length === 1 && stmt.args[0].node === "symbol_ref") {
        const operand = stmt.args[0].name;
        const kind = instances.get(operand.toUpperCase());
        if (kind) {
          const reset: SemanticOperationNode = {
            node: "semantic_operation", id: stmt.id, origin: stmt.origin,
            operation: kind === "timer" ? "timer_reset" : "counter_reset",
            args: [{ role: kind, value: stmt.args[0] }],
            disposition: "equivalent_lowering",
            vendorAnnotations: { mnemonic: "RES" },
          };
          return reset;
        }
        // Operand not resolvable to a timer/counter instance from usage — an
        // explicit unsupported node (manual port), never a name-based guess.
        return {
          node: "unsupported_stmt", id: stmt.id, origin: stmt.origin,
          raw: `RES(${operand})`,
          reason: `RES operand '${operand}' could not be resolved to a timer or counter instance`,
        };
      }
      return { ...stmt, args: stmt.args.map(e) };
    }
    case "semantic_operation": return { ...stmt, args: stmt.args.map((a) => ({ ...a, value: e(a.value) })) };
    default: return stmt;
  }
}

function rewriteUnit<T extends CanonicalRoutine | CanonicalFunction | CanonicalFunctionBlock>(unit: T, target: LanguageId): T {
  // Always walk: even with no detected instances, a lone RES(X) must resolve to
  // an explicit unsupported node (X could not be classified) rather than silently
  // passing through as an ordinary call.
  const instances = collectInstances(unit.body);
  return { ...unit, body: unit.body.map((s) => rewriteStmt(s, instances, target)) };
}

/** Rewrite timer/counter field accesses into canonical instance_field nodes across a program. */
export function lowerInstanceFields(program: CanonicalProgram, target: LanguageId): CanonicalProgram {
  return {
    ...program,
    routines: program.routines.map((r) => rewriteUnit(r, target)),
    functions: program.functions.map((f) => rewriteUnit(f, target)),
    functionBlocks: program.functionBlocks.map((fb) => rewriteUnit(fb, target)),
  };
}
