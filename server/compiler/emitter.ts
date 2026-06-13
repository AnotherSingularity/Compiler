/**
 * MEL Emitter — walks AST nodes and produces GX Works2 Structured Text.
 * Also handles: untranslatable detection, provenance, memory allocation, member rewriting.
 */

import type { ASTNode, VarBlockNode, VarDeclNode, CallNode, FBInvokeNode, AssignNode, IfNode, CaseNode, ForNode, WhileNode, RepeatNode, BinaryOpNode, UnaryOpNode, CompareNode, LogicalNode, IdentNode, LiteralNode, MemberAccessNode, BitAccessNode, IndexNode, FunctionCallNode, TypeCastNode, CommentNode } from "./parser";
import type { Diagnostic } from "../translate";

// Untranslatable calls — matched against FunctionCall/Call AST nodes
const UNTRANSLATABLE: Record<string, { code: string; message: string }> = {
  PID: { code: "AB_MEL_PID_001", message: "PID/PIDE block requires manual port. Configure Mitsubishi PID loop manually." },
  PIDE: { code: "AB_MEL_PID_001", message: "PIDE block requires manual port." },
  MSG: { code: "AB_MEL_MSG_001", message: "MSG (CIP) — consider SLMP or CC-Link IE Field." },
  MAOC: { code: "AB_MEL_MOTION_001", message: "Motion instruction requires Mitsubishi positioning module." },
  MAM: { code: "AB_MEL_MOTION_001", message: "Motion instruction requires Mitsubishi positioning module." },
  MAJ: { code: "AB_MEL_MOTION_001", message: "Motion instruction requires Mitsubishi positioning module." },
  MSO: { code: "AB_MEL_MOTION_001", message: "Motion instruction requires Mitsubishi positioning module." },
  MAFR: { code: "AB_MEL_MOTION_001", message: "Motion instruction requires Mitsubishi positioning module." },
};

const PID_PARAMS = ["SP", "PV", "OUT", "Kp", "Ki", "Kd", "MAXO", "MINO", "DB", "SWM", "SO", "ERR", "BIAS"];

// Timer member map AB→MEL
const TIMER_MEMBERS: Record<string, string> = { DN: "Q", TT: "Q", PRE: "PT", ACC: "ET", EN: "EN" };
const COUNTER_MEMBERS: Record<string, string> = { DN: "Q", PRE: "PV", ACC: "CV", CU: "CU", CD: "CD" };

// Memory allocator
class Allocator {
  private ptrs: Record<string, number> = { M: 1000, D_INT: 5000, D_DINT: 1000, D_REAL: 9000, D_STR: 15000, T: 0, C: 0 };
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

export interface EmitResult {
  output: string;
  diagnostics: Diagnostic[];
  translatedNodes: number;
  mappingYaml: string;
  labelsCsv: string;
}

export function emitMEL(ast: ASTNode[], sourceFile: string, sourceLines: string[]): EmitResult {
  const diags: Diagnostic[] = [];
  const allocator = new Allocator();
  let translated = 0;
  const out: string[] = [];
  // Track instances that triggered MANUAL_PORT (e.g., PID instances)
  const manualPortInstances = new Set<string>();

  // Extract base identifier from an AST node (for member access checks)
  function getBaseIdent(node: ASTNode): string {
    if (node.kind === "ident") return (node as IdentNode).name;
    if (node.kind === "member_access") return getBaseIdent((node as MemberAccessNode).object);
    if (node.kind === "index") return getBaseIdent((node as IndexNode).array);
    return "";
  }

  function provenance(line: number): string {
    const orig = sourceLines[line - 1]?.trim() || "";
    return `// [AB→MEL] src: ${sourceFile} line ${line} | orig: "${orig}"`;
  }

  function emitExpr(node: ASTNode): string {
    switch (node.kind) {
      case "ident": return (node as IdentNode).name;
      case "literal": return (node as LiteralNode).value;
      case "binary_op": {
        const n = node as BinaryOpNode;
        if (n.op === "**") return `EXPT(${emitExpr(n.left)}, ${emitExpr(n.right)})`;
        return `(${emitExpr(n.left)} ${n.op} ${emitExpr(n.right)})`;
      }
      case "unary_op": { const n = node as UnaryOpNode; return `${n.op} ${emitExpr(n.operand)}`; }
      case "compare": { const n = node as CompareNode; return `(${emitExpr(n.left)} ${n.op} ${emitExpr(n.right)})`; }
      case "logical": { const n = node as LogicalNode; return `(${emitExpr(n.left)} ${n.op} ${emitExpr(n.right)})`; }
      case "member_access": {
        const n = node as MemberAccessNode;
        const obj = emitExpr(n.object);
        const baseIdent = getBaseIdent(n.object);
        // If this references a MANUAL_PORT instance, flag it
        if (manualPortInstances.has(baseIdent)) {
          // Emit diagnostic for this reference
          diags.push({ severity: "MANUAL_PORT", code: "AB_MEL_PID_002", message: `Reference to manual-ported instance: ${baseIdent}.${n.member} — no MEL equivalent`, line: n.line });
          // Return a placeholder variable name that the engineer must replace
          return `${baseIdent}_${n.member} (* NEEDS_MANUAL_MAP *)`;
        }
        // Rewrite timer/counter members
        const melMember = TIMER_MEMBERS[n.member] || COUNTER_MEMBERS[n.member] || n.member;
        return `${obj}.${melMember}`;
      }
      case "bit_access": {
        const n = node as BitAccessNode;
        return `BTEST(${emitExpr(n.object)}, ${n.bit})`;
      }
      case "index": {
        const n = node as IndexNode;
        return `${emitExpr(n.array)}[${n.indices.map(emitExpr).join(", ")}]`;
      }
      case "function_call": {
        const n = node as FunctionCallNode;
        // Type conversions: keep IEC standard names (DINT_TO_INT, REAL_TO_DINT, etc.)
        // These are valid in GX Works2 — do NOT rewrite to bare type names
        return `${n.name}(${n.args.map(emitExpr).join(", ")})`;
      }
      case "type_cast": { const n = node as TypeCastNode; return `${n.targetType}(${emitExpr(n.expr)})`; }
      default: return "???";
    }
  }

  function emitStmts(stmts: ASTNode[], indent: string) {
    for (const stmt of stmts) emitStmt(stmt, indent);
  }

  function emitStmt(node: ASTNode, indent: string) {
    switch (node.kind) {
      case "comment": {
        const n = node as CommentNode;
        out.push(`${indent}${n.text}`);
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
        const target = emitExpr(n.target);
        const value = emitExpr(n.value);
        // Bit-write: if target is BTEST, conditionally BSET/BRST based on RHS
        if (target.startsWith("BTEST(")) {
          const match = target.match(/BTEST\((.+),\s*(\d+)\)/);
          if (match) {
            const word = match[1];
            const bit = match[2];
            // If RHS is a constant, emit directly
            if (value === "1" || value === "TRUE") {
              out.push(`${indent}BSET(TRUE, ${word}, ${bit});`);
            } else if (value === "0" || value === "FALSE") {
              out.push(`${indent}BRST(TRUE, ${word}, ${bit});`);
            } else {
              // RHS is a variable/expression — conditional set/reset
              out.push(`${indent}IF ${value} THEN`);
              out.push(`${indent}  BSET(TRUE, ${word}, ${bit});`);
              out.push(`${indent}ELSE`);
              out.push(`${indent}  BRST(TRUE, ${word}, ${bit});`);
              out.push(`${indent}END_IF;`);
            }
            translated++;
            break;
          }
        }
        // Check if target references a MANUAL_PORT instance
        if (manualPortInstances.has(getBaseIdent(n.target))) {
          diags.push({ severity: "MANUAL_PORT", code: "AB_MEL_PID_002", message: `Reference to manual-ported instance member: ${target}`, line: n.line });
          out.push(`${indent}(* MANUAL PORT: ${target} := ${value} — instance has no MEL equivalent *)`);
          translated++;
          break;
        }
        out.push(`${indent}${target} := ${value};`);
        translated++;
        break;
      }
      case "call": {
        const n = node as CallNode;
        // Check untranslatable
        if (UNTRANSLATABLE[n.name]) {
          const info = UNTRANSLATABLE[n.name];
          diags.push({ severity: "MANUAL_PORT", code: info.code, message: info.message, line: n.line });
          // Track the first arg as a manual-ported instance
          if (n.args[0] && n.args[0].kind === "ident") {
            manualPortInstances.add((n.args[0] as IdentNode).name);
          }
          out.push(`${indent}(* MANUAL PORT REQUIRED: ${n.name} block from ${sourceFile}:${n.line}`);
          out.push(`${indent}   Original call: ${sourceLines[n.line - 1]?.trim() || n.name + "(...)"}`);
          out.push(`${indent}   ${info.message}`);
          if (n.name === "PID" || n.name === "PIDE") {
            out.push(`${indent}   Loop parameters to configure on Mitsubishi side:`);
            const inst = n.args[0] ? emitExpr(n.args[0]) : n.name;
            for (const p of PID_PARAMS) out.push(`${indent}     ${inst}.${p}`);
          }
          out.push(`${indent}*)`);
          translated++;
          break;
        }
        // Timer calls: TON(inst) → inst(IN := ..., PT := ...)
        if (["TON", "TOF", "RTO", "TONR"].includes(n.name) && n.args.length === 1 && n.args[0].kind === "ident") {
          const inst = (n.args[0] as IdentNode).name;
          out.push(`${indent}${provenance(n.line)}`);
          out.push(`${indent}${inst}(IN := ${inst}_EN, PT := ${inst}_PT);`);
          if (n.name === "RTO" || n.name === "TONR") {
            diags.push({ severity: "WARN", code: "AB_MEL_TIMER_001", message: `Retentive timer ${inst} — verify reset path.`, line: n.line });
          }
          translated++;
          break;
        }
        // Counter calls
        if (["CTU", "CTD", "CTUD"].includes(n.name) && n.args.length === 1 && n.args[0].kind === "ident") {
          const inst = (n.args[0] as IdentNode).name;
          out.push(`${indent}${provenance(n.line)}`);
          if (n.name === "CTU") out.push(`${indent}${inst}(CU := ${inst}_CU, R := ${inst}_R, PV := ${inst}_PV);`);
          else if (n.name === "CTD") out.push(`${indent}${inst}(CD := ${inst}_CD, LD := ${inst}_LD, PV := ${inst}_PV);`);
          else out.push(`${indent}${inst}(CU := ${inst}_CU, CD := ${inst}_CD, R := ${inst}_R, PV := ${inst}_PV);`);
          translated++;
          break;
        }
        // Generic call
        out.push(`${indent}${provenance(n.line)}`);
        out.push(`${indent}${n.name}(${n.args.map(emitExpr).join(", ")});`);
        translated++;
        break;
      }
      case "function_call": {
        const n = node as FunctionCallNode;
        // Same untranslatable check
        if (UNTRANSLATABLE[n.name]) {
          const info = UNTRANSLATABLE[n.name];
          diags.push({ severity: "MANUAL_PORT", code: info.code, message: info.message, line: n.line });
          out.push(`${indent}(* MANUAL PORT REQUIRED: ${n.name} block from ${sourceFile}:${n.line}`);
          out.push(`${indent}   Original call: ${sourceLines[n.line - 1]?.trim() || ""}`);
          out.push(`${indent}   ${info.message}`);
          if (n.name === "PID" || n.name === "PIDE") {
            out.push(`${indent}   Loop parameters to configure on Mitsubishi side:`);
            const inst = n.args[0] ? emitExpr(n.args[0]) : n.name;
            for (const p of PID_PARAMS) out.push(`${indent}     ${inst}.${p}`);
          }
          out.push(`${indent}*)`);
          translated++;
          break;
        }
        out.push(`${indent}${provenance(n.line)}`);
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
        if (n.elseBlock) { out.push(`${indent}ELSE`); emitStmts(n.elseBlock, indent + "  "); }
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
        if (n.elseBlock) { out.push(`${indent}ELSE`); emitStmts(n.elseBlock, indent + "  "); }
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
      case "exit": { out.push(`${indent}EXIT;`); translated++; break; }
      case "return": { out.push(`${indent}RETURN;`); translated++; break; }
      default: break;
    }
  }

  emitStmts(ast, "");

  // Build mapping
  let mappingYaml = "allocations: {}\n";
  let labelsCsv = "Class,Label,DataType,Device,Comment";
  if (allocator.allocs.length) {
    mappingYaml = "allocations:\n" + allocator.allocs.map(a => `  ${a.name}:\n    device: ${a.device}\n    type: ${a.type}`).join("\n") + "\n";
    labelsCsv = "Class,Label,DataType,Device,Comment\n" + allocator.allocs.map(a => `VAR_GLOBAL,${a.name},${a.type},${a.device},`).join("\n");
  }

  if (translated === 0) {
    diags.push({ severity: "WARN", code: "AB_MEL_PIPELINE_001", message: "Pipeline produced no translated nodes.", line: 0 });
  }

  return { output: out.join("\n"), diagnostics: diags, translatedNodes: translated, mappingYaml, labelsCsv };
}
