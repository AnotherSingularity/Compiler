/**
 * Conversion recognition + lowering.
 *
 * Rewrites canonical `function_call` expressions whose name is an IEC standard
 * type-conversion (`<FROM>_TO_<TO>`, e.g. `DINT_TO_REAL`) into canonical
 * `conversion` nodes carrying `from`/`to` canonical types and a classified
 * `ConversionSafety`. The original vendor spelling is preserved on each type's
 * `sourceSpelling` so target emission reconstructs the exact `<FROM>_TO_<TO>`
 * form (round-trip-exact for every recognized primitive, including BYTE/WORD/
 * DWORD which do not round-trip through the canonical type alone).
 *
 * A conversion whose FROM/TO are not both recognized primitive spellings is left
 * as an ordinary function call (routed by its family) — never guessed. Pure and
 * deterministic; node ids, origins, and statement order are preserved.
 */
import type { Expression, FunctionCallExpr } from "../ir/expressions";
import type {
  Statement,
  AssignmentStmt,
  ConditionalStmt,
  CaseStmt,
  ForStmt,
  WhileStmt,
  RepeatStmt,
} from "../ir/statements";
import type { CanonicalProgram } from "../ir/project";
import type { CanonicalRoutine, CanonicalFunction, CanonicalFunctionBlock } from "../ir/declarations";
import { BOOL, REAL32, REAL64, int, type CanonicalType } from "../ir/types";
import { classifyConversion } from "./conversions";

/** Recognized primitive type spelling → canonical type (spelling attached by caller). */
function primitiveByName(spelling: string): CanonicalType | null {
  switch (spelling.toUpperCase()) {
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

/** Parse `<FROM>_TO_<TO>` into (from, to) canonical types with source spellings, or null. */
function parseConversionName(name: string): { from: CanonicalType; to: CanonicalType } | null {
  const idx = name.toUpperCase().indexOf("_TO_");
  if (idx <= 0) return null;
  const fromSpelling = name.slice(0, idx);
  const toSpelling = name.slice(idx + 4);
  const from = primitiveByName(fromSpelling);
  const to = primitiveByName(toSpelling);
  if (!from || !to) return null;
  return {
    from: { ...from, sourceSpelling: fromSpelling.toUpperCase() },
    to: { ...to, sourceSpelling: toSpelling.toUpperCase() },
  };
}

/** True if a function name is a recognized IEC conversion. */
export function isConversionFunction(name: string): boolean {
  return parseConversionName(name) !== null;
}

function lowerCall(call: FunctionCallExpr): Expression {
  if (call.args.length !== 1) return call; // TYPE_TO_TYPE is unary
  const parsed = parseConversionName(call.name);
  if (!parsed) return call;
  const operand = lowerExpr(call.args[0]);
  return {
    node: "conversion",
    id: call.id,
    origin: call.origin,
    operand,
    from: parsed.from,
    to: parsed.to,
    safety: classifyConversion(parsed.from, parsed.to),
    type: parsed.to,
  };
}

function lowerExpr(expr: Expression): Expression {
  switch (expr.node) {
    case "function_call": {
      const lowered = lowerCall(expr);
      if (lowered.node === "conversion") return lowered;
      return { ...expr, args: expr.args.map(lowerExpr) };
    }
    case "member_access": return { ...expr, object: lowerExpr(expr.object) };
    case "array_access": return { ...expr, array: lowerExpr(expr.array), indices: expr.indices.map(lowerExpr) };
    case "unary": return { ...expr, operand: lowerExpr(expr.operand) };
    case "binary":
    case "comparison":
    case "logical": return { ...expr, left: lowerExpr(expr.left), right: lowerExpr(expr.right) };
    case "conversion": return { ...expr, operand: lowerExpr(expr.operand) };
    case "range": return { ...expr, low: lowerExpr(expr.low), high: lowerExpr(expr.high) };
    case "fb_invoke": return { ...expr, namedArgs: expr.namedArgs.map((a) => ({ ...a, value: lowerExpr(a.value) })) };
    default: return expr;
  }
}

function lowerStmt(stmt: Statement): Statement {
  switch (stmt.node) {
    case "assignment": {
      const s = stmt as AssignmentStmt;
      return { ...s, target: lowerExpr(s.target), value: lowerExpr(s.value) };
    }
    case "conditional": {
      const s = stmt as ConditionalStmt;
      return { ...s, branches: s.branches.map((b) => ({ condition: lowerExpr(b.condition), body: b.body.map(lowerStmt) })), elseBody: s.elseBody ? s.elseBody.map(lowerStmt) : null };
    }
    case "case": {
      const s = stmt as CaseStmt;
      return { ...s, selector: lowerExpr(s.selector), branches: s.branches.map((b) => ({ labels: b.labels.map(lowerExpr), body: b.body.map(lowerStmt) })), elseBody: s.elseBody ? s.elseBody.map(lowerStmt) : null };
    }
    case "for": {
      const s = stmt as ForStmt;
      return { ...s, from: lowerExpr(s.from), to: lowerExpr(s.to), by: s.by ? lowerExpr(s.by) : null, body: s.body.map(lowerStmt) };
    }
    case "while": {
      const s = stmt as WhileStmt;
      return { ...s, condition: lowerExpr(s.condition), body: s.body.map(lowerStmt) };
    }
    case "repeat": {
      const s = stmt as RepeatStmt;
      return { ...s, body: s.body.map(lowerStmt), until: lowerExpr(s.until) };
    }
    case "call":
      return { ...stmt, args: stmt.args.map(lowerExpr) };
    case "fb_invoke_stmt":
      return { ...stmt, namedArgs: stmt.namedArgs.map((a) => ({ ...a, value: lowerExpr(a.value) })) };
    case "semantic_operation":
      return { ...stmt, args: stmt.args.map((a) => ({ ...a, value: lowerExpr(a.value) })) };
    default:
      return stmt;
  }
}

function lowerUnit<T extends CanonicalRoutine | CanonicalFunction | CanonicalFunctionBlock>(unit: T): T {
  return { ...unit, body: unit.body.map(lowerStmt) };
}

/** Rewrite recognized conversion calls into canonical conversion nodes across a program. */
export function lowerConversions(program: CanonicalProgram): CanonicalProgram {
  return {
    ...program,
    routines: program.routines.map(lowerUnit),
    functions: program.functions.map(lowerUnit),
    functionBlocks: program.functionBlocks.map(lowerUnit),
  };
}
