/**
 * Canonical Structured Text emitter (lowering + emission for the expression,
 * assignment, and control-flow families).
 *
 * Consumes canonical IR nodes and produces target ST text. It does NOT parse
 * source, resolve symbols, infer types, or call the legacy translator — it only
 * formats lowered nodes (invariant: emitters format only). Rockwell ST and
 * Mitsubishi ST share this emitter for these families (both are IEC ST); the
 * `target` hook exists for the few spellings that could differ later.
 */
import type { LanguageId } from "../contracts/ids";
import type {
  Expression,
  BinaryOperator,
  ComparisonOperator,
  LogicalOperator,
} from "../ir/expressions";
import type { Statement } from "../ir/statements";
import type { SemanticOperationNode } from "../ir/operations";
import type { CanonicalRoutine } from "../ir/declarations";
import { targetFieldSpelling, type CanonicalField, type InstanceKind } from "../semantic/instance-members";

export class UnsupportedByCanonicalEmitter extends Error {
  constructor(public readonly nodeKind: string) {
    super(`canonical ST emitter has no rule for node "${nodeKind}"`);
    this.name = "UnsupportedByCanonicalEmitter";
  }
}

export interface StEmitTarget {
  language: LanguageId;
}

// Precedence: higher binds tighter.
const PREC_ATOM = 100;
const PREC_UNARY = 90;
const PREC: Record<string, number> = {
  pow: 80,
  "*": 70, "/": 70, mod: 70,
  "+": 60, "-": 60,
  "<": 50, "<=": 50, ">": 50, ">=": 50,
  "=": 45, "<>": 45,
  and: 40, xor: 35, or: 30,
};

const BINOP_TEXT: Record<BinaryOperator, string> = { "+": "+", "-": "-", "*": "*", "/": "/", mod: "MOD", pow: "**" };
const LOGOP_TEXT: Record<LogicalOperator, string> = { and: "AND", or: "OR", xor: "XOR" };

function precedenceOf(expr: Expression): number {
  switch (expr.node) {
    case "binary": return PREC[expr.op] ?? PREC_ATOM;
    case "comparison": return PREC[expr.op] ?? PREC_ATOM;
    case "logical": return PREC[expr.op] ?? PREC_ATOM;
    case "unary": return PREC_UNARY;
    default: return PREC_ATOM;
  }
}

export function emitExpression(expr: Expression, _t: StEmitTarget): string {
  switch (expr.node) {
    case "literal": return expr.raw;
    case "symbol_ref": return expr.name;
    case "member_access": return `${emitExpression(expr.object, _t)}.${expr.member}`;
    case "array_access": return `${emitExpression(expr.array, _t)}[${expr.indices.map((i) => emitExpression(i, _t)).join(", ")}]`;
    case "unary": {
      const inner = wrap(expr.operand, PREC_UNARY, _t);
      return expr.op === "not" ? `NOT ${inner}` : `-${inner}`;
    }
    case "binary": {
      const p = PREC[expr.op] ?? PREC_ATOM;
      return `${wrap(expr.left, p, _t)} ${BINOP_TEXT[expr.op as BinaryOperator]} ${wrapRight(expr.right, p, _t)}`;
    }
    case "comparison": {
      const p = PREC[expr.op] ?? PREC_ATOM;
      return `${wrap(expr.left, p, _t)} ${expr.op as ComparisonOperator} ${wrapRight(expr.right, p, _t)}`;
    }
    case "logical": {
      const p = PREC[expr.op] ?? PREC_ATOM;
      return `${wrap(expr.left, p, _t)} ${LOGOP_TEXT[expr.op as LogicalOperator]} ${wrapRight(expr.right, p, _t)}`;
    }
    case "conversion": {
      // Reconstruct the IEC `<FROM>_TO_<TO>(operand)` form. Source spellings are
      // preserved on the canonical types so BYTE/WORD/DWORD round-trip exactly
      // (they share a bit width/signedness with SINT/INT/DINT). The emitter only
      // formats — from/to and safety were decided by the conversion-lowering
      // pass, not here.
      const from = conversionSpelling(expr.from);
      const to = conversionSpelling(expr.to);
      return `${from}_TO_${to}(${emitExpression(expr.operand, _t)})`;
    }
    case "range":
      return `${emitExpression(expr.low, _t)}..${emitExpression(expr.high, _t)}`;
    case "instance_field": {
      const spelling = targetFieldSpelling(expr.field as CanonicalField, expr.instanceKind as InstanceKind, _t.language) ?? expr.field;
      return `${expr.instance}.${spelling}`;
    }
    default:
      throw new UnsupportedByCanonicalEmitter(expr.node);
  }
}

/**
 * Emit a timer/counter semantic operation as a target FB invocation. The enable
 * (IN/CU/CD) and preset (PT/PV) are NOT present in the ST source (they come from
 * ladder rung context), so they are emitted as explicit TODO placeholders —
 * NEVER as an apparently-valid zero preset (`T#0ms`) — with the authoritative
 * loss record carrying the review requirement. Reset operations emit the target
 * reset mechanism for the resolved instance kind.
 */
function emitOperation(op: SemanticOperationNode, t: StEmitTarget, indent: string): string[] {
  const instArg = op.args.find((a) => a.role === "timer" || a.role === "counter" || a.role === "arg0");
  const inst = instArg && instArg.value.node === "symbol_ref" ? instArg.value.name : "UNKNOWN_INSTANCE";
  const mel = t.language === "mitsubishi-gx-st";
  const argText = op.args.map((a) => emitExpression(a.value, t)).join(", ");
  switch (op.operation) {
    case "timer_on_delay":
    case "timer_off_delay":
    case "timer_retentive":
      return [`${indent}${inst}(IN := TODO_${inst}_enable, PT := TODO_${inst}_preset);`];
    case "counter_up":
      return [`${indent}${inst}(CU := TODO_${inst}_count_up, R := TODO_${inst}_reset, PV := TODO_${inst}_preset);`];
    case "counter_down":
      return [`${indent}${inst}(CD := TODO_${inst}_count_down, LD := TODO_${inst}_load, PV := TODO_${inst}_preset);`];
    case "timer_reset":
      return [`${indent}${inst}(IN := FALSE); (* timer reset *)`];
    case "counter_reset":
      return [`${indent}${inst}(R := TRUE); (* counter reset *)`];
    // ── copy/move family (target-specific block-move primitive) ──────────────
    case "block_copy":
      return [`${indent}${mel ? "BMOV" : "COP"}(${argText});`];
    case "synchronous_block_copy":
      // CPS is a synchronous/atomic copy; the target block-move is not atomic —
      // the authoritative loss record carries the atomicity review requirement.
      return [`${indent}${mel ? "BMOV" : "CPS"}(${argText});`];
    case "masked_move":
      return [`${indent}MVM(${argText});`];
    case "limit_test":
      return [`${indent}${mel ? "LIMIT" : "LIM"}(${argText});`];
    default:
      throw new UnsupportedByCanonicalEmitter(`semantic_operation:${op.operation}`);
  }
}

/** IEC spelling for a conversion FROM/TO type: preserved source spelling, else canonical. */
function conversionSpelling(t: import("../ir/types").CanonicalType): string {
  if (t.sourceSpelling) return t.sourceSpelling.toUpperCase();
  switch (t.kind) {
    case "boolean": return "BOOL";
    case "integer": {
      const m: Record<string, string> = { "8:true": "SINT", "8:false": "USINT", "16:true": "INT", "16:false": "UINT", "32:true": "DINT", "32:false": "UDINT", "64:true": "LINT", "64:false": "ULINT" };
      return m[`${t.bits}:${t.signed}`] ?? "DINT";
    }
    case "real": return t.bits === 64 ? "LREAL" : "REAL";
    case "time": return "TIME";
    case "string": return "STRING";
    default: return t.kind.toUpperCase();
  }
}

function wrap(child: Expression, parentPrec: number, t: StEmitTarget): string {
  const s = emitExpression(child, t);
  return precedenceOf(child) < parentPrec ? `(${s})` : s;
}
// Right operand of a left-associative operator: parenthesize on equal precedence too.
function wrapRight(child: Expression, parentPrec: number, t: StEmitTarget): string {
  const s = emitExpression(child, t);
  return precedenceOf(child) <= parentPrec ? `(${s})` : s;
}

export function emitStatements(stmts: Statement[], t: StEmitTarget, indent: string): string[] {
  const lines: string[] = [];
  for (const s of stmts) lines.push(...emitStatement(s, t, indent));
  return lines;
}

function emitStatement(stmt: Statement, t: StEmitTarget, indent: string): string[] {
  switch (stmt.node) {
    case "assignment":
      return [`${indent}${emitExpression(stmt.target, t)} := ${emitExpression(stmt.value, t)};`];
    case "conditional": {
      const out: string[] = [];
      stmt.branches.forEach((b, i) => {
        out.push(`${indent}${i === 0 ? "IF" : "ELSIF"} ${emitExpression(b.condition, t)} THEN`);
        out.push(...emitStatements(b.body, t, indent + "  "));
      });
      if (stmt.elseBody) {
        out.push(`${indent}ELSE`);
        out.push(...emitStatements(stmt.elseBody, t, indent + "  "));
      }
      out.push(`${indent}END_IF;`);
      return out;
    }
    case "case": {
      const out: string[] = [`${indent}CASE ${emitExpression(stmt.selector, t)} OF`];
      for (const b of stmt.branches) {
        out.push(`${indent}  ${b.labels.map((l) => emitExpression(l, t)).join(", ")}:`);
        out.push(...emitStatements(b.body, t, indent + "    "));
      }
      if (stmt.elseBody) {
        out.push(`${indent}  ELSE`);
        out.push(...emitStatements(stmt.elseBody, t, indent + "    "));
      }
      out.push(`${indent}END_CASE;`);
      return out;
    }
    case "for": {
      const by = stmt.by ? ` BY ${emitExpression(stmt.by, t)}` : "";
      const out: string[] = [`${indent}FOR ${stmt.variable} := ${emitExpression(stmt.from, t)} TO ${emitExpression(stmt.to, t)}${by} DO`];
      out.push(...emitStatements(stmt.body, t, indent + "  "));
      out.push(`${indent}END_FOR;`);
      return out;
    }
    case "while": {
      const out: string[] = [`${indent}WHILE ${emitExpression(stmt.condition, t)} DO`];
      out.push(...emitStatements(stmt.body, t, indent + "  "));
      out.push(`${indent}END_WHILE;`);
      return out;
    }
    case "repeat": {
      const out: string[] = [`${indent}REPEAT`];
      out.push(...emitStatements(stmt.body, t, indent + "  "));
      out.push(`${indent}UNTIL ${emitExpression(stmt.until, t)} END_REPEAT;`);
      return out;
    }
    case "return": return [`${indent}RETURN;`];
    case "exit": return [`${indent}EXIT;`];
    case "continue": return [`${indent}CONTINUE;`];
    case "noop": return [`${indent}(* ${stmt.reason} *)`];
    case "semantic_operation": return emitOperation(stmt, t, indent);
    default:
      throw new UnsupportedByCanonicalEmitter(stmt.node);
  }
}

/** Emit a routine body (no declarations — those are a separate family). */
export function emitRoutineBody(routine: CanonicalRoutine, t: StEmitTarget): string {
  return emitStatements(routine.body, t, "").join("\n");
}
