/**
 * Minimal source-AST → canonical IR normalizer (Stage 1 core; expanded by the
 * semantic pipeline in Stage 2/3).
 *
 * Maps the existing ST parser AST subset into canonical IR with deterministic,
 * structural node ids and real source provenance. Type resolution is left to
 * Stage 2 — unresolved expressions carry an `unresolved` type, never a fake one.
 */
import type { LanguageId } from "../contracts/ids";
import { lineSpan } from "../contracts/source";
import { nodeIdFromPath, sourceOrigin, type NodeOrigin } from "./nodes";
import {
  BOOL, REAL32, REAL64, int, unresolvedType,
  type CanonicalType,
} from "./types";
import type { Expression, BinaryOperator, ComparisonOperator, LogicalOperator, UnaryOperator, LiteralValueKind } from "./expressions";
import type { Statement, IfBranch, CaseBranch } from "./statements";
import type { CanonicalRoutine, CanonicalVariableDeclaration, VariableDirection } from "./declarations";
import type { CanonicalProgram } from "./project";
import { IR_SCHEMA_VERSION } from "./version";

interface Ctx {
  sourceId: string;
  language: LanguageId;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ast = any;

function origin(ctx: Ctx, node: Ast, sourceNodeKind: string): NodeOrigin {
  const line = typeof node?.line === "number" ? node.line : 1;
  return sourceOrigin(ctx.sourceId, ctx.language, "structured_text", lineSpan(ctx.sourceId, line), { sourceNodeKind });
}

const BINOP: Record<string, BinaryOperator> = { "+": "+", "-": "-", "*": "*", "/": "/", MOD: "mod", "**": "pow" };
const LOGOP: Record<string, LogicalOperator> = { AND: "and", OR: "or", XOR: "xor" };

function litType(litType: string, raw: string): { valueKind: LiteralValueKind; type: CanonicalType } {
  switch (litType) {
    case "real": return { valueKind: "real", type: REAL32 };
    case "bool": return { valueKind: "bool", type: BOOL };
    case "string": return { valueKind: "string", type: { kind: "string" } };
    case "time": return { valueKind: "time", type: { kind: "time" } };
    default: return { valueKind: "int", type: int(32, true) };
  }
}

function primitiveType(spelling: string): CanonicalType {
  const s = spelling.trim().toUpperCase();
  switch (s) {
    case "BOOL": return BOOL;
    case "SINT": case "USINT": case "BYTE": return int(8, s !== "USINT");
    case "INT": case "UINT": case "WORD": return int(16, s !== "UINT" && s !== "WORD");
    case "DINT": case "UDINT": case "DWORD": return int(32, s !== "UDINT" && s !== "DWORD");
    case "LINT": case "ULINT": case "LWORD": return int(64, s !== "ULINT" && s !== "LWORD");
    case "REAL": return REAL32;
    case "LREAL": return REAL64;
    case "TIME": return { kind: "time" };
    case "STRING": return { kind: "string" };
    default: return unresolvedType(spelling);
  }
}

function normalizeExpr(node: Ast, ctx: Ctx, path: string): Expression {
  const id = nodeIdFromPath(path);
  switch (node?.kind) {
    case "literal": {
      const { valueKind, type } = litType(node.litType, node.value);
      return { node: "literal", id, origin: origin(ctx, node, "literal"), valueKind, raw: String(node.value), type };
    }
    case "ident":
      return { node: "symbol_ref", id, origin: origin(ctx, node, "ident"), name: node.name, type: unresolvedType(node.name) };
    case "binary_op":
      return {
        node: "binary", id, origin: origin(ctx, node, "binary_op"),
        op: BINOP[node.op] ?? "+",
        left: normalizeExpr(node.left, ctx, `${path}/l`),
        right: normalizeExpr(node.right, ctx, `${path}/r`),
        type: unresolvedType(),
      };
    case "compare":
      return {
        node: "comparison", id, origin: origin(ctx, node, "compare"),
        op: node.op as ComparisonOperator,
        left: normalizeExpr(node.left, ctx, `${path}/l`),
        right: normalizeExpr(node.right, ctx, `${path}/r`),
        type: BOOL,
      };
    case "logical":
      return {
        node: "logical", id, origin: origin(ctx, node, "logical"),
        op: LOGOP[node.op] ?? "and",
        left: normalizeExpr(node.left, ctx, `${path}/l`),
        right: normalizeExpr(node.right, ctx, `${path}/r`),
        type: BOOL,
      };
    case "unary_op": {
      const op: UnaryOperator = node.op === "NOT" ? "not" : "neg";
      return {
        node: "unary", id, origin: origin(ctx, node, "unary_op"), op,
        operand: normalizeExpr(node.operand, ctx, `${path}/o`),
        type: op === "not" ? BOOL : unresolvedType(),
      };
    }
    case "member_access":
      return {
        node: "member_access", id, origin: origin(ctx, node, "member_access"),
        object: normalizeExpr(node.object, ctx, `${path}/obj`),
        member: node.member, type: unresolvedType(),
      };
    case "bit_access":
      return {
        node: "member_access", id, origin: origin(ctx, node, "bit_access"),
        object: normalizeExpr(node.object, ctx, `${path}/obj`),
        member: String(node.bit), type: BOOL,
      };
    case "index":
      return {
        node: "array_access", id, origin: origin(ctx, node, "index"),
        array: normalizeExpr(node.array, ctx, `${path}/arr`),
        indices: (node.indices as Ast[]).map((ix, i) => normalizeExpr(ix, ctx, `${path}/ix[${i}]`)),
        type: unresolvedType(),
      };
    case "function_call":
      return {
        node: "function_call", id, origin: origin(ctx, node, "function_call"),
        name: node.name,
        args: (node.args as Ast[]).map((a, i) => normalizeExpr(a, ctx, `${path}/arg[${i}]`)),
        type: unresolvedType(),
      };
    case "fb_invoke": {
      const entries = Object.entries(node.args as Record<string, Ast>).sort(([a], [b]) => a.localeCompare(b));
      return {
        node: "fb_invoke", id, origin: origin(ctx, node, "fb_invoke"),
        instance: node.instance,
        namedArgs: entries.map(([name, value], i) => ({ name, value: normalizeExpr(value, ctx, `${path}/na[${i}]`) })),
        type: unresolvedType(),
      };
    }
    case "range":
      return {
        node: "range", id, origin: origin(ctx, node, "range"),
        low: normalizeExpr(node.low, ctx, `${path}/lo`),
        high: normalizeExpr(node.high, ctx, `${path}/hi`),
        type: unresolvedType(),
      };
    default:
      return { node: "unresolved_expr", id, origin: origin(ctx, node ?? {}, String(node?.kind ?? "unknown")), raw: JSON.stringify(node ?? null), reason: `unhandled expression kind ${node?.kind}`, type: unresolvedType() };
  }
}

function normalizeStmtList(list: Ast[], ctx: Ctx, path: string): Statement[] {
  const out: Statement[] = [];
  list.forEach((n, i) => {
    const s = normalizeStmt(n, ctx, `${path}/stmt[${i}]`);
    if (s) out.push(s);
  });
  return out;
}

function normalizeStmt(node: Ast, ctx: Ctx, path: string): Statement | null {
  const id = nodeIdFromPath(path);
  switch (node?.kind) {
    case "comment":
    case "var_block":
      return null; // comments dropped; var_blocks handled as declarations
    case "assign":
      return {
        node: "assignment", id, origin: origin(ctx, node, "assign"),
        target: normalizeExpr(node.target, ctx, `${path}/t`),
        value: normalizeExpr(node.value, ctx, `${path}/v`),
      };
    case "if": {
      const branches: IfBranch[] = [
        { condition: normalizeExpr(node.condition, ctx, `${path}/if/c`), body: normalizeStmtList(node.thenBlock, ctx, `${path}/if/then`) },
        ...(node.elsifBranches as Ast[]).map((b, i) => ({
          condition: normalizeExpr(b.condition, ctx, `${path}/elif[${i}]/c`),
          body: normalizeStmtList(b.block, ctx, `${path}/elif[${i}]`),
        })),
      ];
      return {
        node: "conditional", id, origin: origin(ctx, node, "if"),
        branches, elseBody: node.elseBlock ? normalizeStmtList(node.elseBlock, ctx, `${path}/else`) : null,
      };
    }
    case "case": {
      const branches: CaseBranch[] = (node.branches as Ast[]).map((b, i) => ({
        labels: (b.labels as Ast[]).map((l, j) => normalizeExpr(l, ctx, `${path}/case[${i}]/lbl[${j}]`)),
        body: normalizeStmtList(b.block, ctx, `${path}/case[${i}]`),
      }));
      return {
        node: "case", id, origin: origin(ctx, node, "case"),
        selector: normalizeExpr(node.selector, ctx, `${path}/sel`),
        branches, elseBody: node.elseBlock ? normalizeStmtList(node.elseBlock, ctx, `${path}/else`) : null,
      };
    }
    case "for":
      return {
        node: "for", id, origin: origin(ctx, node, "for"),
        variable: node.variable,
        from: normalizeExpr(node.start, ctx, `${path}/from`),
        to: normalizeExpr(node.end, ctx, `${path}/to`),
        by: node.step ? normalizeExpr(node.step, ctx, `${path}/by`) : null,
        body: normalizeStmtList(node.body, ctx, `${path}`),
      };
    case "while":
      return {
        node: "while", id, origin: origin(ctx, node, "while"),
        condition: normalizeExpr(node.condition, ctx, `${path}/c`),
        body: normalizeStmtList(node.body, ctx, `${path}`),
      };
    case "repeat":
      return {
        node: "repeat", id, origin: origin(ctx, node, "repeat"),
        body: normalizeStmtList(node.body, ctx, `${path}`),
        until: normalizeExpr(node.until, ctx, `${path}/until`),
      };
    case "return":
      return { node: "return", id, origin: origin(ctx, node, "return") };
    case "exit":
      return { node: "exit", id, origin: origin(ctx, node, "exit") };
    case "call":
      return {
        node: "call", id, origin: origin(ctx, node, "call"),
        name: node.name,
        args: (node.args as Ast[]).map((a, i) => normalizeExpr(a, ctx, `${path}/arg[${i}]`)),
        callKind: "unknown",
      };
    case "fb_invoke": {
      const entries = Object.entries(node.args as Record<string, Ast>).sort(([a], [b]) => a.localeCompare(b));
      return {
        node: "fb_invoke_stmt", id, origin: origin(ctx, node, "fb_invoke"),
        instance: node.instance,
        namedArgs: entries.map(([name, value], i) => ({ name, value: normalizeExpr(value, ctx, `${path}/na[${i}]`) })),
      };
    }
    default:
      return { node: "unsupported_stmt", id, origin: origin(ctx, node ?? {}, String(node?.kind ?? "unknown")), raw: JSON.stringify(node ?? null).slice(0, 500), reason: `unhandled statement kind ${node?.kind}` };
  }
}

const DIRECTION: Record<string, VariableDirection> = {
  VAR: "local", VAR_INPUT: "input", VAR_OUTPUT: "output", VAR_IN_OUT: "in_out", VAR_GLOBAL: "global", VAR_TEMP: "temp",
};

function collectLocals(ast: Ast[], ctx: Ctx, path: string): CanonicalVariableDeclaration[] {
  const decls: CanonicalVariableDeclaration[] = [];
  ast.forEach((node, bi) => {
    if (node?.kind !== "var_block") return;
    const direction = DIRECTION[node.scope] ?? "local";
    (node.decls as Ast[]).forEach((d, di) => {
      const p = `${path}/var[${bi}][${di}]/${d.name}`;
      decls.push({
        node: "var_decl", id: nodeIdFromPath(p), origin: origin(ctx, d, "var_decl"),
        name: d.name, type: primitiveType(d.type), direction,
        storage: node.scope === "VAR_GLOBAL" ? "normal" : "normal",
        initial: d.initial ? normalizeExpr(d.initial, ctx, `${p}/init`) : null,
      });
    });
  });
  return decls;
}

/** Normalize a list of parsed ST statements into a canonical routine. */
export function normalizeStRoutineAst(
  routineName: string,
  ast: Ast[],
  ctx: Ctx,
  pathPrefix = "",
): CanonicalRoutine {
  const path = `${pathPrefix}routine[${routineName}]`;
  return {
    node: "routine",
    id: nodeIdFromPath(path),
    origin: sourceOrigin(ctx.sourceId, ctx.language, "structured_text", lineSpan(ctx.sourceId, 1), { sourceNodeKind: "routine" }),
    name: routineName,
    locals: collectLocals(ast, ctx, path),
    body: normalizeStmtList(ast.filter((n) => n?.kind !== "var_block"), ctx, path),
    bodyOrigin: "st",
  };
}

/** Wrap a single ST routine as a canonical program (single-unit programs). */
export function normalizeStProgram(programName: string, ast: Ast[], ctx: Ctx): CanonicalProgram {
  void IR_SCHEMA_VERSION;
  const path = `${programName}/`;
  const routine = normalizeStRoutineAst("main", ast, ctx, path);
  return {
    node: "program",
    id: nodeIdFromPath(`${programName}`),
    origin: sourceOrigin(ctx.sourceId, ctx.language, "structured_text", lineSpan(ctx.sourceId, 1), { sourceNodeKind: "program" }),
    name: programName,
    languageOrigins: [ctx.language],
    dataTypes: [],
    globals: [],
    resources: [],
    routines: [routine],
    functions: [],
    functionBlocks: [],
    metadata: { partial: false },
  };
}
