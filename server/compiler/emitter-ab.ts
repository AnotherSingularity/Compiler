/**
 * AB Emitter — walks AST and produces Allen-Bradley (Studio 5000 / RSLogix
 * 5000) Structured Text. This is the reverse direction of emitMEL.
 *
 * Strategy: both AB and MEL ST are IEC 61131-3 dialects, so the parser is
 * shared. This emitter walks the AST and applies AB-specific rewrites:
 *
 *   - Timer/counter members: .Q → .DN, .PT → .PRE, .ET → .ACC, .PV → .PRE,
 *     .CV → .ACC.
 *   - Mitsubishi intrinsics → AB equivalents:
 *       BMOV(src, dst, n) → COP(src, dst, n)
 *       FMOV(val, dst, n) → FLL(val, dst, n)
 *       LIMIT(min, in, max) → LIM(min, in, max)
 *       EXPT(a, b) → a ** b
 *   - Mitsubishi-specific instructions with no AB equivalent (OUT_M, SET_M,
 *     RST_M, SLMP_*) → MANUAL_PORT diagnostic.
 *   - Timer/counter FB invocations (Inst(IN := ..., PT := ...);) → AB call
 *     form: TON(Inst); plus separate .EN := ... ; and .PRE := ... ; lines
 *     for the arguments.
 *   - Bit-of-word syntax (X.N := Y) preserved — supported in both.
 */

import type {
  ASTNode,
  VarBlockNode,
  CallNode,
  FBInvokeNode,
  AssignNode,
  IfNode,
  CaseNode,
  ForNode,
  WhileNode,
  RepeatNode,
  BinaryOpNode,
  UnaryOpNode,
  CompareNode,
  LogicalNode,
  IdentNode,
  LiteralNode,
  MemberAccessNode,
  BitAccessNode,
  IndexNode,
  FunctionCallNode,
  TypeCastNode,
  CommentNode,
} from "./parser";
import type { Diagnostic } from "../translate";

// ─── Mitsubishi instructions without AB equivalents ──────────────────────

const UNTRANSLATABLE: Record<string, { code: string; message: string }> = {
  OUT_M: { code: "MEL_AB_BIT_001",  message: "OUT_M (output to bit device) — use AB bit-of-word write: X.N := Y;" },
  SET_M: { code: "MEL_AB_BIT_002",  message: "SET_M (set bit device) — use AB OTL or X.N := TRUE;" },
  RST_M: { code: "MEL_AB_BIT_003",  message: "RST_M (reset bit device) — use AB OTU or X.N := FALSE;" },
  PLS:   { code: "MEL_AB_PULSE_01", message: "PLS (pulse on rising edge) — use AB ONS or BOOL rising-edge logic." },
  PLF:   { code: "MEL_AB_PULSE_02", message: "PLF (pulse on falling edge) — use AB ONS with negated logic." },
  CALL:  { code: "MEL_AB_FLOW_001", message: "CALL (subroutine call) — use AB JSR or direct function call." },
  FEND:  { code: "MEL_AB_FLOW_002", message: "FEND (main routine end) — AB programs don't use explicit end markers." },
};

// Reverse of the AB→MEL timer/counter member maps.
const TIMER_MEMBERS_REV: Record<string, string> = {
  Q:  "DN",
  PT: "PRE",
  ET: "ACC",
  EN: "EN",
};
const COUNTER_MEMBERS_REV: Record<string, string> = {
  Q:  "DN",
  PV: "PRE",
  CV: "ACC",
  CU: "CU",
  CD: "CD",
};

const INSTRUCTION_REWRITES: Record<string, (args: ASTNode[], emit: (n: ASTNode) => string) => string> = {
  BMOV:  (args, e) => args.length >= 3 ? `COP(${e(args[0])}, ${e(args[1])}, ${e(args[2])})` : `COP(${args.map(e).join(", ")})`,
  FMOV:  (args, e) => args.length >= 3 ? `FLL(${e(args[1])}, ${e(args[0])}, ${e(args[2])})` : `FLL(${args.map(e).join(", ")})`,
  LIMIT: (args, e) => args.length >= 3 ? `LIM(${e(args[0])}, ${e(args[1])}, ${e(args[2])})` : `LIM(${args.map(e).join(", ")})`,
  EXPT:  (args, e) => args.length >= 2 ? `(${e(args[0])} ** ${e(args[1])})` : `EXPT(${args.map(e).join(", ")})`,
  // IEC math: same name in AB and MEL
  ABS:   (args, e) => `ABS(${args.map(e).join(", ")})`,
  SQRT:  (args, e) => `SQRT(${args.map(e).join(", ")})`,
  SIN:   (args, e) => `SIN(${args.map(e).join(", ")})`,
  COS:   (args, e) => `COS(${args.map(e).join(", ")})`,
  TAN:   (args, e) => `TAN(${args.map(e).join(", ")})`,
  ASIN:  (args, e) => `ASN(${args.map(e).join(", ")})`,
  ACOS:  (args, e) => `ACS(${args.map(e).join(", ")})`,
  ATAN:  (args, e) => `ATN(${args.map(e).join(", ")})`,
  LN:    (args, e) => `LN(${args.map(e).join(", ")})`,
  LOG:   (args, e) => `LOG(${args.map(e).join(", ")})`,
};

// ─── Public API ──────────────────────────────────────────────────────────

export interface EmitResult {
  output: string;
  diagnostics: Diagnostic[];
  translatedNodes: number;
  mappingYaml: string;
  labelsCsv: string;
}

function escapeForComment(s: string): string {
  return s.replace(/\*\)/g, "*\\)").replace(/\(\*/g, "(\\*");
}

export function emitAB(
  ast: ASTNode[],
  sourceFile: string,
  sourceLines: string[],
): EmitResult {
  const diags: Diagnostic[] = [];
  let translated = 0;
  const out: string[] = [];

  function provenance(line: number): string {
    const orig = sourceLines[line - 1]?.trim() || "";
    return `// [MEL→AB] ${sourceFile}:${line} | ${orig}`;
  }

  // ── Expressions ───────────────────────────────────────────────────────

  function emitExpr(node: ASTNode): string {
    switch (node.kind) {
      case "ident": return (node as IdentNode).name;
      case "literal": return (node as LiteralNode).value;

      case "binary_op": {
        const n = node as BinaryOpNode;
        if (n.op === "**") return `(${emitExpr(n.left)} ** ${emitExpr(n.right)})`;
        return `(${emitExpr(n.left)} ${n.op} ${emitExpr(n.right)})`;
      }
      case "unary_op": {
        const n = node as UnaryOpNode;
        if (n.op === "-") return `-${emitExpr(n.operand)}`;
        return `${n.op} ${emitExpr(n.operand)}`;
      }
      case "compare": {
        const n = node as CompareNode;
        return `(${emitExpr(n.left)} ${n.op} ${emitExpr(n.right)})`;
      }
      case "logical": {
        const n = node as LogicalNode;
        return `(${emitExpr(n.left)} ${n.op} ${emitExpr(n.right)})`;
      }

      case "member_access": {
        const n = node as MemberAccessNode;
        const obj = emitExpr(n.object);
        const abMember = TIMER_MEMBERS_REV[n.member] || COUNTER_MEMBERS_REV[n.member] || n.member;
        return `${obj}.${abMember}`;
      }

      case "bit_access": {
        const n = node as BitAccessNode;
        return `${emitExpr(n.object)}.${n.bit}`;
      }

      case "index": {
        const n = node as IndexNode;
        return `${emitExpr(n.array)}[${n.indices.map(emitExpr).join(", ")}]`;
      }

      case "function_call": {
        const n = node as FunctionCallNode;
        const rewrite = INSTRUCTION_REWRITES[n.name];
        if (rewrite) return rewrite(n.args, emitExpr);
        return `${n.name}(${n.args.map(emitExpr).join(", ")})`;
      }

      case "type_cast": {
        const n = node as TypeCastNode;
        return `${n.targetType}(${emitExpr(n.expr)})`;
      }

      default:
        return `(* UNSUPPORTED_EXPR_${node.kind} *)`;
    }
  }

  // ── Statements ────────────────────────────────────────────────────────

  function emitStmts(stmts: ASTNode[], indent: string) {
    for (const stmt of stmts) emitStmt(stmt, indent);
  }

  function emitStmt(node: ASTNode, indent: string) {
    switch (node.kind) {
      case "comment": {
        out.push(`${indent}${(node as CommentNode).text}`);
        break;
      }

      case "var_block": {
        // AB ST uses VAR/END_VAR too. Just emit them as declared, drop any
        // device-binding (AT M100) since AB uses tag-based addressing.
        const n = node as VarBlockNode;
        out.push(`${indent}${n.scope}`);
        for (const d of n.decls) {
          out.push(`${indent}  ${provenance(d.line)}`);
          const init = d.initial ? ` := ${emitExpr(d.initial)}` : "";
          // Strip "AT D1000" if present; AB doesn't need it
          const cleanType = d.type.replace(/\s*AT\s+[MDCT]\d+/i, "");
          out.push(`${indent}  ${d.name} : ${cleanType}${init};`);
          translated++;
        }
        out.push(`${indent}END_VAR`);
        break;
      }

      case "assign": {
        const n = node as AssignNode;
        out.push(`${indent}${provenance(n.line)}`);
        out.push(`${indent}${emitExpr(n.target)} := ${emitExpr(n.value)};`);
        translated++;
        break;
      }

      case "call": {
        const n = node as CallNode;
        if (UNTRANSLATABLE[n.name]) {
          const info = UNTRANSLATABLE[n.name];
          diags.push({
            severity: "MANUAL_PORT",
            code: info.code,
            message: info.message,
            line: n.line,
          });
          out.push(`${indent}(* MANUAL PORT REQUIRED: ${n.name} (${sourceFile}:${n.line})`);
          out.push(`${indent}   original: ${escapeForComment(sourceLines[n.line - 1]?.trim() || `${n.name}(...)`)}`);
          out.push(`${indent}   note: ${info.message}`);
          out.push(`${indent}*)`);
          translated++;
          break;
        }
        if (INSTRUCTION_REWRITES[n.name]) {
          out.push(`${indent}${INSTRUCTION_REWRITES[n.name](n.args, emitExpr)};`);
          translated++;
          break;
        }
        out.push(`${indent}${n.name}(${n.args.map(emitExpr).join(", ")});`);
        translated++;
        break;
      }

      case "function_call": {
        const n = node as FunctionCallNode;
        if (UNTRANSLATABLE[n.name]) {
          const info = UNTRANSLATABLE[n.name];
          diags.push({
            severity: "MANUAL_PORT",
            code: info.code,
            message: info.message,
            line: n.line,
          });
          out.push(`${indent}(* MANUAL PORT REQUIRED: ${n.name} (${sourceFile}:${n.line})`);
          out.push(`${indent}   original: ${escapeForComment(sourceLines[n.line - 1]?.trim() || "")}`);
          out.push(`${indent}   note: ${info.message}`);
          out.push(`${indent}*)`);
          translated++;
          break;
        }
        if (INSTRUCTION_REWRITES[n.name]) {
          out.push(`${indent}${INSTRUCTION_REWRITES[n.name](n.args, emitExpr)};`);
          translated++;
          break;
        }
        out.push(`${indent}${n.name}(${n.args.map(emitExpr).join(", ")});`);
        translated++;
        break;
      }

      case "fb_invoke" as any: {
        // MEL form:  Inst(IN := <enable>, PT := <preset>);
        // AB form:   Inst's enable is a rung condition, not a member write.
        //            .PRE/.PV are settable; .IN/.CU/.R/.CD/.LD are NOT.
        //
        // The honest translation is a manual-port comment showing the
        // original MEL call plus an AB-shaped IF-wrapped TON/CTU template
        // for the engineer to wire into the surrounding logic.
        const n = node as unknown as FBInvokeNode;

        // Try to classify: which kind of FB is this? We don't have type
        // info from the parser, so use the parameter names as a hint.
        const argNames = Object.keys(n.args);
        const isTimer = argNames.includes("IN") && argNames.includes("PT");
        const isCounter = argNames.some((a) => a === "CU" || a === "CD");
        const enable =
          n.args["IN"] || n.args["CU"] || n.args["CD"] || null;
        const preset = n.args["PT"] || n.args["PV"] || null;
        const reset = n.args["R"] || n.args["LD"] || null;

        out.push(`${indent}${provenance(n.line)}`);
        out.push(`${indent}(* MEL→AB: ${n.instance}(${argNames.map((a) => `${a} := ...`).join(", ")})`);
        out.push(`${indent}   AB has no direct equivalent of MEL's named-arg FB invocation.`);
        out.push(`${indent}   In AB ST, set settable members (.PRE), then call the instruction:`);
        out.push(`${indent}*)`);

        // Settable members go through directly
        if (preset) {
          const presetMember = isTimer ? "PRE" : isCounter ? "PRE" : "PRE";
          out.push(`${indent}${n.instance}.${presetMember} := ${emitExpr(preset)};`);
        }
        // Skip a dead reset guard when the value is literally FALSE/0.
        const resetIsDead =
          reset?.kind === "literal" &&
          ((reset as LiteralNode).value === "FALSE" || (reset as LiteralNode).value === "0");
        if (reset && !resetIsDead) {
          out.push(`${indent}IF ${emitExpr(reset)} THEN RES(${n.instance}); END_IF;`);
        }

        // Enable signal -> wrap the actual instruction call
        if (enable) {
          const instrGuess = isTimer
            ? "TON"
            : isCounter
              ? argNames.includes("CD") && argNames.includes("CU")
                ? "CTUD"
                : argNames.includes("CD")
                  ? "CTD"
                  : "CTU"
              : `TODO_${n.instance}_instruction`;
          // If enable is literally TRUE/1, skip the IF wrap and emit the
          // call unconditionally.
          const enableIsAlways =
            enable.kind === "literal" &&
            ((enable as LiteralNode).value === "TRUE" || (enable as LiteralNode).value === "1");
          if (enableIsAlways) {
            out.push(`${indent}${instrGuess}(${n.instance});`);
          } else {
            out.push(`${indent}IF ${emitExpr(enable)} THEN`);
            out.push(`${indent}  ${instrGuess}(${n.instance});`);
            out.push(`${indent}END_IF;`);
          }
        } else {
          out.push(`${indent}(* TODO: AB ${isTimer ? "TON" : isCounter ? "CTU" : "FB"}(${n.instance}); — provide rung-enable condition *)`);
        }

        diags.push({
          severity: "MANUAL_PORT",
          code: "MEL_AB_FB_001",
          message: `FB invocation ${n.instance} — verify generated AB structure matches original MEL semantics`,
          line: n.line,
        });
        translated++;
        break;
      }

      case "if": {
        const n = node as IfNode;
        out.push(`${indent}${provenance(n.line)}`);
        out.push(`${indent}IF ${emitExpr(n.condition)} THEN`);
        emitStmts(n.thenBlock, indent + "  ");
        for (const elif of n.elsifBranches) {
          out.push(`${indent}ELSIF ${emitExpr(elif.condition)} THEN`);
          emitStmts(elif.block, indent + "  ");
        }
        if (n.elseBlock) {
          out.push(`${indent}ELSE`);
          emitStmts(n.elseBlock, indent + "  ");
        }
        out.push(`${indent}END_IF;`);
        translated++;
        break;
      }

      case "case": {
        const n = node as CaseNode;
        out.push(`${indent}${provenance(n.line)}`);
        out.push(`${indent}CASE ${emitExpr(n.selector)} OF`);
        for (const br of n.branches) {
          out.push(`${indent}  ${br.labels.map(emitExpr).join(", ")}:`);
          emitStmts(br.block, indent + "    ");
        }
        if (n.elseBlock) {
          out.push(`${indent}ELSE`);
          emitStmts(n.elseBlock, indent + "  ");
        }
        out.push(`${indent}END_CASE;`);
        translated++;
        break;
      }

      case "for": {
        const n = node as ForNode;
        out.push(`${indent}${provenance(n.line)}`);
        const step = n.step ? ` BY ${emitExpr(n.step)}` : "";
        out.push(`${indent}FOR ${n.variable} := ${emitExpr(n.start)} TO ${emitExpr(n.end)}${step} DO`);
        emitStmts(n.body, indent + "  ");
        out.push(`${indent}END_FOR;`);
        translated++;
        break;
      }

      case "while": {
        const n = node as WhileNode;
        out.push(`${indent}${provenance(n.line)}`);
        out.push(`${indent}WHILE ${emitExpr(n.condition)} DO`);
        emitStmts(n.body, indent + "  ");
        out.push(`${indent}END_WHILE;`);
        translated++;
        break;
      }

      case "repeat": {
        const n = node as RepeatNode;
        out.push(`${indent}${provenance(n.line)}`);
        out.push(`${indent}REPEAT`);
        emitStmts(n.body, indent + "  ");
        out.push(`${indent}UNTIL ${emitExpr(n.until)} END_REPEAT;`);
        translated++;
        break;
      }

      case "exit":   { out.push(`${indent}EXIT;`);   translated++; break; }
      case "return": { out.push(`${indent}RETURN;`); translated++; break; }
      default: break;
    }
  }

  emitStmts(ast, "");

  if (translated === 0) {
    diags.push({
      severity: "WARN",
      code: "MEL_AB_PIPELINE_001",
      message: "Pipeline produced no translated nodes.",
      line: 0,
    });
  }

  return {
    output: out.join("\n"),
    diagnostics: diags,
    translatedNodes: translated,
    mappingYaml: "allocations: {}\n",
    labelsCsv: "Class,Label,DataType,Device,Comment",
  };
}
