/**
 * Semantic resolver pass (scope + symbol + type resolution).
 *
 * Walks a canonical program and fills in resolved symbol ids and canonical types
 * on expressions, using the scope tables from `scopes.ts`. It is pure and
 * deterministic (node ids, origins, and statement order are preserved) and it
 * NEVER fabricates a resolved type: an identifier not found in scope keeps its
 * `unresolved` type, and any expression built from an unresolved operand stays
 * unresolved. This is the connective tissue that makes symbol/type information
 * available to lowering, capability evaluation, and loss recording.
 */
import type { Expression } from "../ir/expressions";
import type {
  Statement,
  ConditionalStmt,
  CaseStmt,
  ForStmt,
  WhileStmt,
  RepeatStmt,
  AssignmentStmt,
} from "../ir/statements";
import type { CanonicalProgram } from "../ir/project";
import type { CanonicalRoutine, CanonicalFunction, CanonicalFunctionBlock } from "../ir/declarations";
import type { CanonicalType, StructureType, ArrayType } from "../ir/types";
import { BOOL, unresolvedType } from "../ir/types";
import { Scope, buildProgramScope, buildRoutineScope, withLoopIndex } from "./scopes";
import { arithmeticResultType, isUnresolved } from "./types";

function memberType(objectType: CanonicalType, member: string): CanonicalType {
  if (objectType.kind === "structure") {
    const m = (objectType as StructureType).members.find((x) => x.name.toUpperCase() === member.toUpperCase());
    if (m) return m.type;
  }
  return unresolvedType(member, "member of non-structure or unknown member");
}

function indexedElementType(arrayType: CanonicalType, indexCount: number): CanonicalType {
  if (arrayType.kind !== "array") return unresolvedType(undefined, "index of non-array");
  const arr = arrayType as ArrayType;
  // Full indexing (index count == dimension count) yields the element type;
  // partial indexing yields a lower-rank array (kept unresolved — rare in ST).
  if (indexCount === arr.dimensions.length) return arr.element;
  return unresolvedType(undefined, "partial array indexing");
}

function resolveExpr(expr: Expression, scope: Scope): Expression {
  switch (expr.node) {
    case "literal":
      return expr;
    case "symbol_ref": {
      const sym = scope.resolve(expr.name);
      if (!sym) return expr; // unresolved — do not guess
      return { ...expr, symbolId: sym.symbolId, type: sym.type };
    }
    case "member_access": {
      const object = resolveExpr(expr.object, scope);
      return { ...expr, object, type: memberType(object.type, expr.member) };
    }
    case "array_access": {
      const array = resolveExpr(expr.array, scope);
      const indices = expr.indices.map((i) => resolveExpr(i, scope));
      return { ...expr, array, indices, type: indexedElementType(array.type, indices.length) };
    }
    case "unary": {
      const operand = resolveExpr(expr.operand, scope);
      const type = expr.op === "not" ? BOOL : isUnresolved(operand.type) ? unresolvedType() : operand.type;
      return { ...expr, operand, type };
    }
    case "binary": {
      const left = resolveExpr(expr.left, scope);
      const right = resolveExpr(expr.right, scope);
      return { ...expr, left, right, type: arithmeticResultType(left.type, right.type) };
    }
    case "comparison": {
      return { ...expr, left: resolveExpr(expr.left, scope), right: resolveExpr(expr.right, scope), type: BOOL };
    }
    case "logical": {
      return { ...expr, left: resolveExpr(expr.left, scope), right: resolveExpr(expr.right, scope), type: BOOL };
    }
    case "conversion":
      return { ...expr, operand: resolveExpr(expr.operand, scope) };
    case "range": {
      const low = resolveExpr(expr.low, scope);
      const high = resolveExpr(expr.high, scope);
      return { ...expr, low, high, type: isUnresolved(low.type) ? high.type : low.type };
    }
    case "function_call":
      return { ...expr, args: expr.args.map((a) => resolveExpr(a, scope)) };
    case "fb_invoke":
      return { ...expr, namedArgs: expr.namedArgs.map((a) => ({ ...a, value: resolveExpr(a.value, scope) })) };
    default:
      return expr; // instance_field / hardware_ref / vendor_extension / unresolved_expr
  }
}

function resolveStmt(stmt: Statement, scope: Scope): Statement {
  switch (stmt.node) {
    case "assignment": {
      const s = stmt as AssignmentStmt;
      return { ...s, target: resolveExpr(s.target, scope), value: resolveExpr(s.value, scope) };
    }
    case "conditional": {
      const s = stmt as ConditionalStmt;
      return {
        ...s,
        branches: s.branches.map((b) => ({ condition: resolveExpr(b.condition, scope), body: b.body.map((x) => resolveStmt(x, scope)) })),
        elseBody: s.elseBody ? s.elseBody.map((x) => resolveStmt(x, scope)) : null,
      };
    }
    case "case": {
      const s = stmt as CaseStmt;
      return {
        ...s,
        selector: resolveExpr(s.selector, scope),
        branches: s.branches.map((b) => ({ labels: b.labels.map((l) => resolveExpr(l, scope)), body: b.body.map((x) => resolveStmt(x, scope)) })),
        elseBody: s.elseBody ? s.elseBody.map((x) => resolveStmt(x, scope)) : null,
      };
    }
    case "for": {
      const s = stmt as ForStmt;
      const inner = withLoopIndex(scope, s.variable, s.id);
      return {
        ...s,
        from: resolveExpr(s.from, inner),
        to: resolveExpr(s.to, inner),
        by: s.by ? resolveExpr(s.by, inner) : null,
        body: s.body.map((x) => resolveStmt(x, inner)),
      };
    }
    case "while": {
      const s = stmt as WhileStmt;
      return { ...s, condition: resolveExpr(s.condition, scope), body: s.body.map((x) => resolveStmt(x, scope)) };
    }
    case "repeat": {
      const s = stmt as RepeatStmt;
      return { ...s, body: s.body.map((x) => resolveStmt(x, scope)), until: resolveExpr(s.until, scope) };
    }
    case "call":
      return { ...stmt, args: stmt.args.map((a) => resolveExpr(a, scope)) };
    case "fb_invoke_stmt":
      return { ...stmt, namedArgs: stmt.namedArgs.map((a) => ({ ...a, value: resolveExpr(a.value, scope) })) };
    case "semantic_operation":
      return { ...stmt, args: stmt.args.map((a) => ({ ...a, value: resolveExpr(a.value, scope) })) };
    default:
      return stmt; // vendor_extension_stmt / unsupported_stmt / noop / return / exit / continue
  }
}

function resolveRoutine<T extends CanonicalRoutine | CanonicalFunction | CanonicalFunctionBlock>(unit: T, programScope: Scope): T {
  const params = "parameters" in unit ? unit.parameters : [];
  const scope = buildRoutineScope(programScope, unit.locals, unit.id, params);
  return { ...unit, body: unit.body.map((s) => resolveStmt(s, scope)) };
}

/**
 * Resolve symbols and types across a whole program. Pure: returns a new program;
 * the input is not mutated. Node ids, origins, and statement order are preserved.
 */
export function resolveProgram(program: CanonicalProgram): CanonicalProgram {
  const programScope = buildProgramScope(program);
  return {
    ...program,
    routines: program.routines.map((r) => resolveRoutine(r, programScope)),
    functions: program.functions.map((f) => resolveRoutine(f, programScope)),
    functionBlocks: program.functionBlocks.map((fb) => resolveRoutine(fb, programScope)),
  };
}
