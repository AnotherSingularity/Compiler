/**
 * MEL Emitter — walks AST and produces GX Works2 Structured Text.
 *
 * Responsibilities:
 *   1. Translate Allen-Bradley instruction syntax to Mitsubishi where there
 *      is a direct equivalent (MOV → :=, COP → BMOV, LIM → LIMIT, etc.).
 *   2. Identify untranslatable AB instructions (PID, PIDE, MSG, motion, JSR
 *      labels) and emit MANUAL_PORT diagnostics with structured comments.
 *   3. Rewrite AB timer/counter member access (.DN → .Q, .PRE → .PT) for
 *      reads, and emit MEL FB-invoke form for TON/TOF/TONR/CTU calls with
 *      honest placeholder comments where the AB rung context is lost.
 *   4. Preserve bit-of-word syntax (X.N := bool, X.N as read) directly —
 *      GX Works2 supports this natively, no BTEST/BSET wrapper needed.
 *   5. Allocate Mitsubishi device addresses (M/D/T/C) for declared vars.
 */

import type {
  ASTNode,
  VarBlockNode,
  VarDeclNode,
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

// ─── Untranslatable AB instructions ───────────────────────────────────────

const UNTRANSLATABLE: Record<string, { code: string; message: string }> = {
  PID:  { code: "AB_MEL_PID_001",    message: "PID block requires manual port. Configure Mitsubishi PID loop (S(P).PID, QnUDV PID FB, or Process CPU PID instruction)." },
  PIDE: { code: "AB_MEL_PID_001",    message: "PIDE block requires manual port. Mitsubishi has no direct PIDE equivalent — split into Mitsubishi PID instructions or use Process CPU FBs." },
  MSG:  { code: "AB_MEL_MSG_001",    message: "MSG (CIP message) — replace with SLMP frame, CC-Link IE Field client, or Ethernet/IP scanner instruction." },
  MAOC: { code: "AB_MEL_MOTION_001", message: "Motion output cam — requires Mitsubishi Simple Motion / MR-J5 setup." },
  MAM:  { code: "AB_MEL_MOTION_001", message: "Motion Absolute Move — requires Mitsubishi positioning module / QD75 / Simple Motion." },
  MAJ:  { code: "AB_MEL_MOTION_001", message: "Motion Axis Jog — requires Mitsubishi positioning module." },
  MSO:  { code: "AB_MEL_MOTION_001", message: "Motion Servo On — requires Mitsubishi positioning module." },
  MAFR: { code: "AB_MEL_MOTION_001", message: "Motion Axis Fault Reset — requires Mitsubishi positioning module." },
  JSR:  { code: "AB_MEL_FLOW_001",   message: "JSR (jump to subroutine) — convert to function call: SubroutineName();" },
  LBL:  { code: "AB_MEL_FLOW_002",   message: "LBL (label) — MEL discourages labels in ST. Restructure with IF/CASE/loop." },
  JMP:  { code: "AB_MEL_FLOW_002",   message: "JMP (jump) — MEL discourages goto/jmp in ST. Restructure control flow." },
  TND:  { code: "AB_MEL_FLOW_003",   message: "TND (temporary end) — MEL has no equivalent; use RETURN inside a function block." },
  SBR:  { code: "AB_MEL_FLOW_004",   message: "SBR (subroutine define) — express as MEL FUNCTION_BLOCK or FUNCTION." },
  RET:  { code: "AB_MEL_FLOW_005",   message: "RET (subroutine return) — use MEL RETURN keyword." },
};

const PID_PARAMS = [
  "SP", "SPHLimit", "SPLLimit", "SPProg", "SPOper",
  "PV", "PVHigh", "PVLow",
  "OUT", "OUTHLim", "OUTLLim", "CVHLimit", "CVLLimit",
  "Kp", "Ki", "Kd", "TI", "TD",
  "DB", "SWM", "SO", "MAXO", "MINO", "BIAS", "ERR", "UPD",
];

const TIMER_MEMBERS: Record<string, string> = {
  DN: "Q",
  PRE: "PT",
  ACC: "ET",
  EN: "EN",
};
const COUNTER_MEMBERS: Record<string, string> = {
  DN: "Q",
  PRE: "PV",
  ACC: "CV",
  CU: "CU",
  CD: "CD",
};

const INSTRUCTION_REWRITES: Record<string, (args: ASTNode[], emit: (n: ASTNode) => string) => string> = {
  MOV:  (args, e) => args.length >= 2 ? `${e(args[1])} := ${e(args[0])}` : `MOV(${args.map(e).join(", ")})`,
  CLR:  (args, e) => args.length >= 1 ? `${e(args[0])} := 0` : `CLR()`,
  COP:  (args, e) => args.length >= 3 ? `BMOV(${e(args[0])}, ${e(args[1])}, ${e(args[2])})` : `BMOV(${args.map(e).join(", ")})`,
  CPS:  (args, e) => args.length >= 3 ? `BMOV(${e(args[0])}, ${e(args[1])}, ${e(args[2])})` : `BMOV(${args.map(e).join(", ")})`,
  FLL:  (args, e) => args.length >= 3 ? `FMOV(${e(args[0])}, ${e(args[1])}, ${e(args[2])})` : `FMOV(${args.map(e).join(", ")})`,
  ABS:  (args, e) => `ABS(${args.map(e).join(", ")})`,
  SQR:  (args, e) => `SQRT(${args.map(e).join(", ")})`,
  SQRT: (args, e) => `SQRT(${args.map(e).join(", ")})`,
  CPT:  (args, e) => args.length >= 2 ? `${e(args[0])} := ${e(args[1])}` : `CPT(${args.map(e).join(", ")})`,
  LIM:  (args, e) => args.length >= 3 ? `LIMIT(${e(args[0])}, ${e(args[1])}, ${e(args[2])})` : `LIMIT(${args.map(e).join(", ")})`,
  MEQ:  (args, e) => args.length >= 3 ? `((${e(args[0])} AND ${e(args[1])}) = ${e(args[2])})` : `MEQ(${args.map(e).join(", ")})`,
  SIN:  (args, e) => `SIN(${args.map(e).join(", ")})`,
  COS:  (args, e) => `COS(${args.map(e).join(", ")})`,
  TAN:  (args, e) => `TAN(${args.map(e).join(", ")})`,
  ASN:  (args, e) => `ASIN(${args.map(e).join(", ")})`,
  ACS:  (args, e) => `ACOS(${args.map(e).join(", ")})`,
  ATN:  (args, e) => `ATAN(${args.map(e).join(", ")})`,
  LN:   (args, e) => `LN(${args.map(e).join(", ")})`,
  LOG:  (args, e) => `LOG(${args.map(e).join(", ")})`,
};

// ─── Allocator ───────────────────────────────────────────────────────────

class Allocator {
  private ptrs: Record<string, number> = {
    M: 1000, D_INT: 5000, D_DINT: 1000, D_REAL: 9000, D_STR: 15000, T: 0, C: 0,
  };
  allocs: Array<{ name: string; type: string; device: string }> = [];

  allocate(name: string, type: string): string {
    const t = type.toUpperCase();
    let dev: string;
    if (t === "BOOL") { dev = `M${this.ptrs.M}`; this.ptrs.M++; }
    else if (["INT", "SINT", "UINT", "USINT"].includes(t)) { dev = `D${this.ptrs.D_INT}`; this.ptrs.D_INT++; }
    else if (["DINT", "UDINT", "LINT"].includes(t)) { dev = `D${this.ptrs.D_DINT}`; this.ptrs.D_DINT += 2; }
    else if (["REAL", "LREAL"].includes(t)) { dev = `D${this.ptrs.D_REAL}`; this.ptrs.D_REAL += 2; }
    else if (["TIMER", "TON", "TOF", "RTO", "TONR"].includes(t)) { dev = `T${this.ptrs.T}`; this.ptrs.T++; }
    else if (["COUNTER", "CTU", "CTD", "CTUD"].includes(t)) { dev = `C${this.ptrs.C}`; this.ptrs.C++; }
    else if (t.startsWith("STRING")) { dev = `D${this.ptrs.D_STR}`; this.ptrs.D_STR += 41; }
    else { dev = `D${this.ptrs.D_DINT}`; this.ptrs.D_DINT += 2; }
    this.allocs.push({ name, type: t, device: dev });
    return dev;
  }
}

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

export function emitMEL(
  ast: ASTNode[],
  sourceFile: string,
  sourceLines: string[],
): EmitResult {
  const diags: Diagnostic[] = [];
  const allocator = new Allocator();
  let translated = 0;
  const out: string[] = [];
  const manualPortInstances = new Set<string>();
  const seenManualPortRefs = new Set<string>();

  function getBaseIdent(node: ASTNode): string {
    if (node.kind === "ident") return (node as IdentNode).name;
    if (node.kind === "member_access") return getBaseIdent((node as MemberAccessNode).object);
    if (node.kind === "index") return getBaseIdent((node as IndexNode).array);
    if (node.kind === "bit_access") return getBaseIdent((node as BitAccessNode).object);
    return "";
  }

  function provenance(line: number): string {
    // Line comments don't need block-comment escaping — // ends at newline.
    const orig = sourceLines[line - 1]?.trim() || "";
    return `// [AB→MEL] ${sourceFile}:${line} | ${orig}`;
  }

  // Pre-pass: collect every identifier that gets passed as the first arg to
  // an untranslatable instruction. Subsequent member access on those names
  // will be flagged and emitted with a manual-map placeholder.
  function collectManualPortInstances(nodes: ASTNode[]) {
    for (const node of nodes) {
      if (!node) continue;
      if (node.kind === "call" || node.kind === "function_call") {
        const n = node as CallNode | FunctionCallNode;
        if (UNTRANSLATABLE[n.name] && n.args[0]?.kind === "ident") {
          manualPortInstances.add((n.args[0] as IdentNode).name);
        }
      } else if (node.kind === "if") {
        const n = node as IfNode;
        collectManualPortInstances(n.thenBlock);
        for (const elif of n.elsifBranches) collectManualPortInstances(elif.block);
        if (n.elseBlock) collectManualPortInstances(n.elseBlock);
      } else if (node.kind === "for") {
        collectManualPortInstances((node as ForNode).body);
      } else if (node.kind === "while") {
        collectManualPortInstances((node as WhileNode).body);
      } else if (node.kind === "repeat") {
        collectManualPortInstances((node as RepeatNode).body);
      } else if (node.kind === "case") {
        const n = node as CaseNode;
        for (const br of n.branches) collectManualPortInstances(br.block);
        if (n.elseBlock) collectManualPortInstances(n.elseBlock);
      }
    }
  }
  collectManualPortInstances(ast);

  // ── Expressions ───────────────────────────────────────────────────────

  function emitExpr(node: ASTNode): string {
    switch (node.kind) {
      case "ident": return (node as IdentNode).name;
      case "literal": return (node as LiteralNode).value;

      case "binary_op": {
        const n = node as BinaryOpNode;
        if (n.op === "**") return `EXPT(${emitExpr(n.left)}, ${emitExpr(n.right)})`;
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
        const baseIdent = getBaseIdent(n.object);
        if (manualPortInstances.has(baseIdent)) {
          const refKey = `${baseIdent}.${n.member}`;
          if (!seenManualPortRefs.has(refKey)) {
            seenManualPortRefs.add(refKey);
            diags.push({
              severity: "MANUAL_PORT",
              code: "AB_MEL_PID_002",
              message: `Reference to manual-ported instance member: ${refKey} — no direct MEL mapping`,
              line: n.line,
            });
          }
          // Placeholder identifier — keep it as a single valid identifier so
          // downstream tools don't choke. The "_MANUAL" suffix flags it.
          return `${baseIdent}_${n.member}_MANUAL`;
        }
        const obj = emitExpr(n.object);
        const melMember = TIMER_MEMBERS[n.member] || COUNTER_MEMBERS[n.member] || n.member;
        return `${obj}.${melMember}`;
      }

      case "bit_access": {
        // GX Works2 supports direct .N bit-of-word syntax natively.
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
        const n = node as VarBlockNode;
        out.push(`${indent}${n.scope}`);
        for (const d of n.decls) {
          const dev = allocator.allocate(d.name, d.type);
          out.push(`${indent}  ${provenance(d.line)}`);
          const init = d.initial ? ` := ${emitExpr(d.initial)}` : "";
          out.push(`${indent}  ${d.name} AT ${dev} : ${d.type}${init};`);
          translated++;
        }
        out.push(`${indent}END_VAR`);
        break;
      }

      case "assign": {
        const n = node as AssignNode;
        out.push(`${indent}${provenance(n.line)}`);

        const targetBase = getBaseIdent(n.target);
        if (manualPortInstances.has(targetBase)) {
          const target = emitExpr(n.target);
          const value = emitExpr(n.value);
          diags.push({
            severity: "MANUAL_PORT",
            code: "AB_MEL_PID_002",
            message: `Assignment to manual-ported instance member: ${target}`,
            line: n.line,
          });
          // Emit as runnable code with the placeholder LHS, plus an inline
          // comment naming the original AB member. This preserves the RHS
          // operand in code form (so it survives round-tripping and shows up
          // in symbol tables) instead of swallowing it inside a block
          // comment.
          out.push(`${indent}${target} := ${value};  (* MANUAL_PORT: original LHS was a member of manual-ported instance ${targetBase} *)`);
          translated++;
          break;
        }

        // Plain assignment — bit-of-word writes (X.N := Y) emit unchanged.
        const target = emitExpr(n.target);
        const value = emitExpr(n.value);
        out.push(`${indent}${target} := ${value};`);
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
          if (n.args[0] && n.args[0].kind === "ident") {
            manualPortInstances.add((n.args[0] as IdentNode).name);
          }
          out.push(`${indent}(* MANUAL PORT REQUIRED: ${n.name} (${sourceFile}:${n.line})`);
          out.push(`${indent}   original: ${escapeForComment(sourceLines[n.line - 1]?.trim() || `${n.name}(...)`)}`);
          out.push(`${indent}   note: ${info.message}`);
          if (n.name === "PID" || n.name === "PIDE") {
            const inst = n.args[0] ? emitExpr(n.args[0]) : n.name;
            out.push(`${indent}   loop parameters to configure on Mitsubishi side:`);
            for (const p of PID_PARAMS) out.push(`${indent}     ${inst}.${p}`);
          }
          out.push(`${indent}*)`);
          translated++;
          break;
        }

        if (INSTRUCTION_REWRITES[n.name]) {
          out.push(`${indent}${INSTRUCTION_REWRITES[n.name](n.args, emitExpr)};`);
          translated++;
          break;
        }

        // Timer: TON / TOF / RTO / TONR
        if (["TON", "TOF", "RTO", "TONR"].includes(n.name) && n.args.length === 1 && n.args[0].kind === "ident") {
          const inst = (n.args[0] as IdentNode).name;
          out.push(`${indent}(* AB call: ${n.name}(${inst}) — enable + preset come from rung context in AB *)`);
          out.push(`${indent}${inst}(IN := TODO_${inst}_enable, PT := ${inst}.PT);`);
          if (n.name === "RTO" || n.name === "TONR") {
            diags.push({
              severity: "WARN",
              code: "AB_MEL_TIMER_001",
              message: `Retentive timer ${inst} (${n.name}) — verify reset path is wired in MEL`,
              line: n.line,
            });
          } else {
            diags.push({
              severity: "INFO",
              code: "AB_MEL_TIMER_002",
              message: `Timer ${inst} (${n.name}) — wire IN to the original AB rung condition (placeholder: TODO_${inst}_enable)`,
              line: n.line,
            });
          }
          translated++;
          break;
        }

        // Counter: CTU / CTD / CTUD
        if (["CTU", "CTD", "CTUD"].includes(n.name) && n.args.length === 1 && n.args[0].kind === "ident") {
          const inst = (n.args[0] as IdentNode).name;
          out.push(`${indent}(* AB call: ${n.name}(${inst}) — count + reset come from rung context in AB *)`);
          if (n.name === "CTU") {
            out.push(`${indent}${inst}(CU := TODO_${inst}_count_up, R := TODO_${inst}_reset, PV := ${inst}.PV);`);
          } else if (n.name === "CTD") {
            out.push(`${indent}${inst}(CD := TODO_${inst}_count_down, LD := TODO_${inst}_load, PV := ${inst}.PV);`);
          } else {
            out.push(`${indent}${inst}(CU := TODO_${inst}_count_up, CD := TODO_${inst}_count_down, R := TODO_${inst}_reset, PV := ${inst}.PV);`);
          }
          diags.push({
            severity: "INFO",
            code: "AB_MEL_COUNTER_001",
            message: `Counter ${inst} (${n.name}) — wire inputs to original AB rung conditions (placeholders: TODO_${inst}_*)`,
            line: n.line,
          });
          translated++;
          break;
        }

        // Unknown call — pass through
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

  // ── Outputs ───────────────────────────────────────────────────────────

  let mappingYaml = "allocations: {}\n";
  let labelsCsv = "Class,Label,DataType,Device,Comment";
  if (allocator.allocs.length) {
    mappingYaml =
      "allocations:\n" +
      allocator.allocs
        .map((a) => `  ${a.name}:\n    device: ${a.device}\n    type: ${a.type}`)
        .join("\n") +
      "\n";
    labelsCsv =
      "Class,Label,DataType,Device,Comment\n" +
      allocator.allocs.map((a) => `VAR_GLOBAL,${a.name},${a.type},${a.device},`).join("\n");
  }

  if (translated === 0) {
    diags.push({
      severity: "WARN",
      code: "AB_MEL_PIPELINE_001",
      message: "Pipeline produced no translated nodes.",
      line: 0,
    });
  }

  return { output: out.join("\n"), diagnostics: diags, translatedNodes: translated, mappingYaml, labelsCsv };
}
