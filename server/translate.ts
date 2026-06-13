/**
 * AB↔MEL Structured Text Translation Engine v0.1.2
 * 
 * Proper comment-aware, statement-level translation.
 * Does NOT do regex replacement on raw source. Instead:
 * 1. Strips and preserves comment blocks
 * 2. Parses lines into code vs comment regions
 * 3. Applies transformations only to code regions
 * 4. Emits provenance on every translated statement
 */

import { z } from "zod";

export interface Diagnostic {
  severity: "INFO" | "WARN" | "MANUAL_PORT" | "ERROR";
  code: string;
  message: string;
  line: number;
}

export interface TranslationResult {
  ok: boolean;
  output: string;
  diagnostics: Diagnostic[];
  mappingYaml: string;
  labelsCsv: string;
  stats: {
    inputLines: number;
    outputLines: number;
    warningCount: number;
    manualPortCount: number;
    translatedNodes: number;
  };
}

// Known untranslatable instructions — only match as CALLS: name(...)
const UNTRANSLATABLE_CALLS: Record<string, { code: string; message: string }> = {
  PID: { code: "AB_MEL_PID_001", message: "PID block requires manual port. Configure Mitsubishi PID loop manually." },
  PIDE: { code: "AB_MEL_PID_001", message: "PIDE block requires manual port." },
  MSG: { code: "AB_MEL_MSG_001", message: "MSG (CIP) — consider SLMP or CC-Link IE Field." },
  MAOC: { code: "AB_MEL_MOTION_001", message: "Motion instruction requires Mitsubishi positioning module." },
  MAM: { code: "AB_MEL_MOTION_001", message: "Motion instruction requires Mitsubishi positioning module." },
  MAJ: { code: "AB_MEL_MOTION_001", message: "Motion instruction requires Mitsubishi positioning module." },
  MSO: { code: "AB_MEL_MOTION_001", message: "Motion instruction requires Mitsubishi positioning module." },
  MAFR: { code: "AB_MEL_MOTION_001", message: "Motion instruction requires Mitsubishi positioning module." },
};

// PID struct members that should be dumped in MANUAL_PORT block
const PID_PARAMS = ["SP", "PV", "OUT", "Kp", "Ki", "Kd", "MAXO", "MINO", "DB", "SWM", "SO", "ERR", "BIAS"];

// === Comment-aware line classification ===

interface ParsedLine {
  lineNum: number;
  raw: string;
  isComment: boolean;      // entire line is inside a block comment
  isLineComment: boolean;  // line starts with //
  code: string;            // the code portion (empty if comment)
  inlineComment: string;   // trailing // comment if any
}

function classifyLines(source: string): ParsedLine[] {
  const lines = source.split("\n");
  const result: ParsedLine[] = [];
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Track block comment state
    if (inBlockComment) {
      result.push({ lineNum: i + 1, raw, isComment: true, isLineComment: false, code: "", inlineComment: "" });
      if (trimmed.includes("*)")) {
        inBlockComment = false;
      }
      continue;
    }

    // Line starts a block comment
    if (trimmed.startsWith("(*")) {
      inBlockComment = !trimmed.includes("*)");
      result.push({ lineNum: i + 1, raw, isComment: true, isLineComment: false, code: "", inlineComment: "" });
      continue;
    }

    // Line comment
    if (trimmed.startsWith("//")) {
      result.push({ lineNum: i + 1, raw, isComment: false, isLineComment: true, code: "", inlineComment: raw });
      continue;
    }

    // Code line — may have inline comment
    let code = raw;
    let inlineComment = "";
    const commentIdx = raw.indexOf("//");
    if (commentIdx >= 0) {
      code = raw.substring(0, commentIdx);
      inlineComment = raw.substring(commentIdx);
    }
    // Also handle inline (* ... *)
    const blockInlineStart = code.indexOf("(*");
    if (blockInlineStart >= 0) {
      const blockInlineEnd = code.indexOf("*)", blockInlineStart);
      if (blockInlineEnd >= 0) {
        inlineComment = code.substring(blockInlineStart, blockInlineEnd + 2) + " " + inlineComment;
        code = code.substring(0, blockInlineStart) + code.substring(blockInlineEnd + 2);
      }
    }

    result.push({ lineNum: i + 1, raw, isComment: false, isLineComment: false, code, inlineComment });
  }

  return result;
}

// === Memory Allocator ===

class MemoryAllocator {
  private ptrs: Record<string, number> = { M: 1000, D_INT: 5000, D_DINT: 1000, D_REAL: 9000, D_STR: 15000, T: 0, C: 0 };
  allocations: Array<{ name: string; type: string; device: string }> = [];

  allocate(name: string, type: string): string {
    const t = type.toUpperCase().trim();
    let dev: string;
    if (t === "BOOL") { dev = `M${this.ptrs.M}`; this.ptrs.M++; }
    else if (["INT", "SINT", "UINT", "USINT"].includes(t)) { dev = `D${this.ptrs.D_INT}`; this.ptrs.D_INT++; }
    else if (["DINT", "UDINT", "LINT"].includes(t)) { dev = `D${this.ptrs.D_DINT}`; this.ptrs.D_DINT += 2; }
    else if (["REAL", "LREAL"].includes(t)) { dev = `D${this.ptrs.D_REAL}`; this.ptrs.D_REAL += 2; }
    else if (["TIMER", "TON", "TOF", "RTO", "TONR"].includes(t)) { dev = `T${this.ptrs.T}`; this.ptrs.T++; }
    else if (["COUNTER", "CTU", "CTD", "CTUD"].includes(t)) { dev = `C${this.ptrs.C}`; this.ptrs.C++; }
    else if (t.startsWith("STRING")) { dev = `D${this.ptrs.D_STR}`; this.ptrs.D_STR += 41; }
    else { dev = `D${this.ptrs.D_DINT}`; this.ptrs.D_DINT += 2; }
    this.allocations.push({ name, type: t, device: dev });
    return dev;
  }

  toYaml(): string {
    if (!this.allocations.length) return "allocations: {}\n";
    let y = "allocations:\n";
    for (const a of this.allocations) y += `  ${a.name}:\n    device: ${a.device}\n    type: ${a.type}\n`;
    return y;
  }

  toCsv(): string {
    const lines = ["Class,Label,DataType,Device,Comment"];
    for (const a of this.allocations) lines.push(`VAR_GLOBAL,${a.name},${a.type},${a.device},`);
    return lines.join("\n");
  }
}

// === AB → MEL Translation ===

function translateABtoMEL(source: string, diagnostics: Diagnostic[], sourceFile: string): {
  output: string; allocator: MemoryAllocator; translatedNodes: number;
} {
  const parsed = classifyLines(source);
  const outputLines: string[] = [];
  const allocator = new MemoryAllocator();
  let translatedNodes = 0;
  let inVarBlock = false;

  for (const pl of parsed) {
    // Pass through comments unchanged
    if (pl.isComment || pl.isLineComment) {
      outputLines.push(pl.raw);
      continue;
    }

    const trimmed = pl.code.trim();
    const indent = pl.code.match(/^(\s*)/)?.[1] || "";

    // Empty code lines
    if (!trimmed) { outputLines.push(pl.raw); continue; }

    // === VAR block handling ===
    if (/^(VAR|VAR_GLOBAL|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT)\b/i.test(trimmed)) {
      inVarBlock = true;
      outputLines.push(pl.raw);
      continue;
    }
    if (/^END_VAR\b/i.test(trimmed)) {
      inVarBlock = false;
      outputLines.push(pl.raw);
      continue;
    }

    if (inVarBlock) {
      // Parse declaration: name : Type [:= init];
      const declMatch = trimmed.match(/^(\w+)\s*:\s*([^;:=]+?)(?:\s*:=\s*(.+?))?\s*;?\s*$/);
      if (declMatch) {
        const [, varName, varType, initVal] = declMatch;
        const cleanType = varType.trim();
        // Skip PID/PIDE type annotations — don't match as calls
        const device = allocator.allocate(varName, cleanType);
        const initPart = initVal ? ` := ${initVal}` : "";
        outputLines.push(`${indent}// [AB→MEL] src: ${sourceFile} line ${pl.lineNum} | orig: "${trimmed}"`);
        outputLines.push(`${indent}${varName} AT ${device} : ${cleanType}${initPart};`);
        translatedNodes++;
        continue;
      }
      outputLines.push(pl.raw);
      continue;
    }

    // === Check for untranslatable CALLS (must be: FUNCNAME( ... ); as a statement) ===
    let wasUntranslatable = false;
    for (const [funcName, info] of Object.entries(UNTRANSLATABLE_CALLS)) {
      // Must match: optional whitespace, FUNCNAME, (, args, ), optional ;
      // Must NOT match inside type annotations (name : TYPE) or comments
      const callRegex = new RegExp(`^${funcName}\\s*\\((.*)\\)\\s*;?\\s*$`);
      const match = trimmed.match(callRegex);
      if (match) {
        const args = match[1];
        diagnostics.push({ severity: "MANUAL_PORT", code: info.code, message: info.message, line: pl.lineNum });
        outputLines.push(`${indent}(* MANUAL PORT REQUIRED: ${funcName} block from ${sourceFile}:${pl.lineNum}`);
        outputLines.push(`${indent}   Original call: ${trimmed}`);
        outputLines.push(`${indent}   ${info.message}`);
        // Parameter dump for PID/PIDE
        if (funcName === "PID" || funcName === "PIDE") {
          outputLines.push(`${indent}   Loop parameters to configure on Mitsubishi side:`);
          const instanceMatch = args.match(/^(\w+)/);
          if (instanceMatch) {
            const inst = instanceMatch[1];
            for (const p of PID_PARAMS) {
              outputLines.push(`${indent}     ${inst}.${p}`);
            }
          }
        }
        outputLines.push(`${indent}*)`);
        translatedNodes++;
        wasUntranslatable = true;
        break;
      }
    }
    if (wasUntranslatable) continue;

    // === Timer call rewriting: TON(instance); → instance(IN := ..., PT := ...); ===
    const timerMatch = trimmed.match(/^(TON|TOF|RTO|TONR)\s*\((\w+)\)\s*;?\s*$/);
    if (timerMatch) {
      const [, timerType, instance] = timerMatch;
      outputLines.push(`${indent}// [AB→MEL] src: ${sourceFile} line ${pl.lineNum} | orig: "${trimmed}"`);
      outputLines.push(`${indent}${instance}(IN := ${instance}_EN, PT := ${instance}_PT);`);
      if (timerType === "RTO" || timerType === "TONR") {
        diagnostics.push({ severity: "WARN", code: "AB_MEL_TIMER_001", message: `Retentive timer ${instance} — verify reset path.`, line: pl.lineNum });
      }
      translatedNodes++;
      continue;
    }

    // === Counter call rewriting ===
    const ctrMatch = trimmed.match(/^(CTU|CTD|CTUD)\s*\((\w+)\)\s*;?\s*$/);
    if (ctrMatch) {
      const [, ctrType, instance] = ctrMatch;
      outputLines.push(`${indent}// [AB→MEL] src: ${sourceFile} line ${pl.lineNum} | orig: "${trimmed}"`);
      if (ctrType === "CTU") outputLines.push(`${indent}${instance}(CU := ${instance}_CU, R := ${instance}_R, PV := ${instance}_PV);`);
      else if (ctrType === "CTD") outputLines.push(`${indent}${instance}(CD := ${instance}_CD, LD := ${instance}_LD, PV := ${instance}_PV);`);
      else outputLines.push(`${indent}${instance}(CU := ${instance}_CU, CD := ${instance}_CD, R := ${instance}_R, PV := ${instance}_PV);`);
      translatedNodes++;
      continue;
    }

    // === Statement-level transformations ===
    let translated = pl.code;
    let changed = false;

    // & → AND (AB uses & as shorthand for AND in some contexts)
    if (/\s&\s|&\s|\s&/.test(translated)) {
      translated = translated.replace(/\s*&\s*/g, " AND ");
      changed = true;
    }

    // Timer member rewrites: .DN→.Q, .TT→.Q, .PRE→.PT, .ACC→.ET, .EN→.EN
    if (/\.(DN|TT|PRE|ACC)\b/.test(translated)) {
      translated = translated.replace(/\.DN\b/g, ".Q");
      translated = translated.replace(/\.TT\b/g, ".Q");
      translated = translated.replace(/\.PRE\b/g, ".PT");
      translated = translated.replace(/\.ACC\b/g, ".ET");
      changed = true;
    }

    // DINT bit access: identifier.N (where N is a number 0-31) → GET_BIT(identifier, N)
    // Pattern: word.digit but NOT word.word (struct member)
    const bitAccessRegex = /(\w+)\.(\d+)\b/g;
    if (bitAccessRegex.test(translated)) {
      bitAccessRegex.lastIndex = 0;
      translated = translated.replace(/(\w+)\.(\d+)\b/g, (match, ident, bit) => {
        const bitNum = parseInt(bit);
        if (bitNum >= 0 && bitNum <= 31) {
          changed = true;
          return `BTEST(${ident}, ${bit})`;
        }
        return match;
      });
    }

    // Power operator ** → EXPT()
    if (/\w+\s*\*\*\s*\w+/.test(translated) && !translated.includes("(*")) {
      translated = translated.replace(/(\w+)\s*\*\*\s*(\w+)/g, "EXPT($1, $2)");
      changed = true;
    }

    // Array indexing [i][j] → [i, j]
    if (/\]\s*\[/.test(translated)) {
      translated = translated.replace(/\]\s*\[/g, ", ");
      changed = true;
    }

    // Emit with provenance if changed
    if (changed) {
      outputLines.push(`${indent}// [AB→MEL] src: ${sourceFile} line ${pl.lineNum} | orig: "${trimmed}"`);
      outputLines.push(translated + (pl.inlineComment ? " " + pl.inlineComment : ""));
      translatedNodes++;
    } else {
      // Even unchanged statements get counted if they're real code
      outputLines.push(pl.raw);
      if (/[:=]|^(IF|ELSIF|ELSE|END_IF|FOR|END_FOR|WHILE|END_WHILE|REPEAT|UNTIL|END_REPEAT|CASE|END_CASE|EXIT)\b/i.test(trimmed)) {
        translatedNodes++;
      }
    }
  }

  if (translatedNodes === 0) {
    diagnostics.push({ severity: "WARN", code: "AB_MEL_PIPELINE_001", message: "Pipeline produced no translated nodes.", line: 0 });
  }

  return { output: outputLines.join("\n"), allocator, translatedNodes };
}

// === MEL → AB Translation ===

function translateMELtoAB(source: string, diagnostics: Diagnostic[], sourceFile: string): {
  output: string; translatedNodes: number;
} {
  const parsed = classifyLines(source);
  const outputLines: string[] = [];
  let translatedNodes = 0;

  for (const pl of parsed) {
    if (pl.isComment || pl.isLineComment) { outputLines.push(pl.raw); continue; }
    const trimmed = pl.code.trim();
    const indent = pl.code.match(/^(\s*)/)?.[1] || "";
    if (!trimmed) { outputLines.push(pl.raw); continue; }

    // RETURN → warn
    if (/^RETURN\s*;?\s*$/i.test(trimmed)) {
      diagnostics.push({ severity: "WARN", code: "AB_MEL_EMIT_001", message: "RETURN not supported in AB ST.", line: pl.lineNum });
      outputLines.push(`${indent}// [MEL→AB] RETURN not supported — restructure control flow`);
      translatedNodes++;
      continue;
    }

    // MEL FB invocation → AB style
    const fbMatch = trimmed.match(/^(\w+)\s*\((?:IN|CU|CD)\s*:=\s*.+\)\s*;?\s*$/);
    if (fbMatch) {
      const instance = fbMatch[1];
      outputLines.push(`${indent}// [MEL→AB] src: ${sourceFile} line ${pl.lineNum} | orig: "${trimmed}"`);
      if (trimmed.includes("IN :=") && trimmed.includes("PT :=")) outputLines.push(`${indent}TON(${instance});`);
      else if (trimmed.includes("CU :=")) outputLines.push(`${indent}CTU(${instance});`);
      else if (trimmed.includes("CD :=")) outputLines.push(`${indent}CTD(${instance});`);
      else outputLines.push(`${indent}${pl.raw}`);
      translatedNodes++;
      continue;
    }

    let translated = pl.code;
    let changed = false;

    // Timer/counter members
    if (/\.(Q|PT|ET|PV|CV)\b/.test(translated)) {
      translated = translated.replace(/\.Q\b/g, ".DN");
      translated = translated.replace(/\.PT\b/g, ".PRE");
      translated = translated.replace(/\.ET\b/g, ".ACC");
      translated = translated.replace(/\.PV\b/g, ".PRE");
      translated = translated.replace(/\.CV\b/g, ".ACC");
      changed = true;
    }

    // BTEST(ident, N) → ident.N
    if (/BTEST\s*\(/.test(translated)) {
      translated = translated.replace(/BTEST\s*\(\s*(\w+)\s*,\s*(\d+)\s*\)/g, "$1.$2");
      changed = true;
    }

    // Remove AT addresses
    if (/\s+AT\s+[A-Z]+\d+/.test(translated)) {
      translated = translated.replace(/\s+AT\s+[A-Z]+\d+/g, "");
      changed = true;
    }

    // EXPT() → **
    if (/EXPT\s*\(/.test(translated)) {
      translated = translated.replace(/EXPT\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/g, "$1 ** $2");
      changed = true;
    }

    // Array [i, j] → [i][j]
    if (/\[[^\]]+,\s*[^\]]+\]/.test(translated)) {
      translated = translated.replace(/\[([^\],]+),\s*([^\]]+)\]/g, "[$1][$2]");
      changed = true;
    }

    // Device references → tag names
    const devPattern = /(?<![a-zA-Z_])(ST\d+|[XYMLBFSDWRTCZV]\d+)(?![a-zA-Z_])/g;
    if (devPattern.test(translated)) {
      devPattern.lastIndex = 0;
      const devs = new Set<string>();
      let m;
      while ((m = devPattern.exec(translated)) !== null) devs.add(m[1]);
      for (const dev of devs) {
        translated = translated.replace(new RegExp(`(?<![a-zA-Z_])${dev}(?![a-zA-Z_])`, "g"), `${dev}_Tag`);
      }
      changed = true;
    }

    if (changed) {
      outputLines.push(`${indent}// [MEL→AB] src: ${sourceFile} line ${pl.lineNum} | orig: "${trimmed}"`);
      outputLines.push(translated);
      translatedNodes++;
    } else {
      outputLines.push(pl.raw);
      if (/[:=]|^(IF|ELSIF|ELSE|END_IF|FOR|END_FOR|WHILE|END_WHILE|REPEAT|UNTIL|END_REPEAT|CASE|END_CASE|EXIT)\b/i.test(trimmed)) {
        translatedNodes++;
      }
    }
  }

  if (translatedNodes === 0) {
    diagnostics.push({ severity: "WARN", code: "AB_MEL_PIPELINE_001", message: "Pipeline produced no translated nodes.", line: 0 });
  }

  return { output: outputLines.join("\n"), translatedNodes };
}

// === Main ===

export function translate(
  source: string,
  direction: "ab2mel" | "mel2ab",
  options?: { memoryMap?: string; labelsCsv?: string }
): TranslationResult {
  const diagnostics: Diagnostic[] = [];
  const inputLines = source.split("\n").length;
  const sourceFile = "<input>";

  let output: string;
  let mappingYaml = "allocations: {}\n";
  let labelsCsv = "Class,Label,DataType,Device,Comment";
  let translatedNodes = 0;

  if (direction === "ab2mel") {
    const r = translateABtoMEL(source, diagnostics, sourceFile);
    output = r.output;
    mappingYaml = r.allocator.toYaml();
    labelsCsv = r.allocator.toCsv();
    translatedNodes = r.translatedNodes;
  } else {
    const r = translateMELtoAB(source, diagnostics, sourceFile);
    output = r.output;
    translatedNodes = r.translatedNodes;
  }

  return {
    ok: !diagnostics.some(d => d.severity === "ERROR"),
    output,
    diagnostics,
    mappingYaml,
    labelsCsv,
    stats: {
      inputLines,
      outputLines: output.split("\n").length,
      warningCount: diagnostics.filter(d => d.severity === "WARN").length,
      manualPortCount: diagnostics.filter(d => d.severity === "MANUAL_PORT").length,
      translatedNodes,
    },
  };
}

export const translateInputSchema = z.object({
  direction: z.enum(["ab2mel", "mel2ab"]),
  source: z.string().min(1, "Source code is required"),
  options: z.object({ memoryMap: z.string().optional(), labelsCsv: z.string().optional() }).optional(),
});
export type TranslateInput = z.infer<typeof translateInputSchema>;
