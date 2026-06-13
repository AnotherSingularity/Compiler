/**
 * AB↔MEL Structured Text Translation Engine v0.1.1
 * 
 * Deterministic source-to-source compiler. Translates between
 * Allen-Bradley Studio 5000 and Mitsubishi GX Works2 Structured Text.
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

// Untranslatable instructions (emit MANUAL_PORT)
const UNTRANSLATABLE: Record<string, { code: string; message: string }> = {
  PID: { code: "AB_MEL_PID_001", message: "PID block requires manual port. Configure Mitsubishi PID loop manually." },
  PIDE: { code: "AB_MEL_PID_001", message: "PIDE block requires manual port. Parameter dump below." },
  MSG: { code: "AB_MEL_MSG_001", message: "MSG (CIP) — consider SLMP or CC-Link IE Field. Topology required." },
  MAOC: { code: "AB_MEL_MOTION_001", message: "Motion instruction requires Mitsubishi positioning module (QD75/RD77MS)." },
  MAM: { code: "AB_MEL_MOTION_001", message: "Motion instruction requires Mitsubishi positioning module (QD75/RD77MS)." },
  MAJ: { code: "AB_MEL_MOTION_001", message: "Motion instruction requires Mitsubishi positioning module (QD75/RD77MS)." },
  MSO: { code: "AB_MEL_MOTION_001", message: "Motion instruction requires Mitsubishi positioning module (QD75/RD77MS)." },
  MAFR: { code: "AB_MEL_MOTION_001", message: "Motion instruction requires Mitsubishi positioning module (QD75/RD77MS)." },
  SCL: { code: "AB_MEL_SCL_001", message: "SCL (Scale) — use MEL FX_SCALE or manual calculation." },
};

// Memory allocator
class MemoryAllocator {
  private pointers: Record<string, number> = {
    M: 1000, D_INT: 5000, D_DINT: 1000, D_REAL: 9000, D_STR: 15000, T: 0, C: 0,
  };
  allocations: Array<{ name: string; type: string; device: string }> = [];

  allocate(name: string, type: string): string {
    let device: string;
    const t = type.toUpperCase();
    if (t === "BOOL") { device = `M${this.pointers.M}`; this.pointers.M++; }
    else if (t === "INT" || t === "SINT" || t === "UINT" || t === "USINT") { device = `D${this.pointers.D_INT}`; this.pointers.D_INT++; }
    else if (t === "DINT" || t === "UDINT" || t === "LINT") { device = `D${this.pointers.D_DINT}`; this.pointers.D_DINT += 2; }
    else if (t === "REAL" || t === "LREAL") { device = `D${this.pointers.D_REAL}`; this.pointers.D_REAL += 2; }
    else if (t === "TIMER" || t === "TON" || t === "TOF" || t === "RTO" || t === "TONR") { device = `T${this.pointers.T}`; this.pointers.T++; }
    else if (t === "COUNTER" || t === "CTU" || t === "CTD" || t === "CTUD") { device = `C${this.pointers.C}`; this.pointers.C++; }
    else if (t.startsWith("STRING")) { device = `D${this.pointers.D_STR}`; this.pointers.D_STR += 41; }
    else { device = `D${this.pointers.D_DINT}`; this.pointers.D_DINT += 2; }
    this.allocations.push({ name, type, device });
    return device;
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

// === AB → MEL ===

function translateABtoMEL(source: string, diagnostics: Diagnostic[], sourceFile: string): {
  output: string; allocator: MemoryAllocator; translatedNodes: number;
} {
  const lines = source.split("\n");
  const outputLines: string[] = [];
  const allocator = new MemoryAllocator();
  let translatedNodes = 0;
  let inVarBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();
    const indent = line.match(/^(\s*)/)?.[1] || "";

    // Empty lines pass through
    if (!trimmed) { outputLines.push(""); continue; }

    // Comments pass through
    if (trimmed.startsWith("//") || trimmed.startsWith("(*")) {
      outputLines.push(line);
      continue;
    }

    // VAR block tracking
    if (/^(VAR|VAR_GLOBAL|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT)\b/i.test(trimmed)) {
      inVarBlock = true;
      outputLines.push(line);
      continue;
    }
    if (/^END_VAR/i.test(trimmed)) {
      inVarBlock = false;
      outputLines.push(line);
      continue;
    }

    // Variable declarations → allocate device addresses
    if (inVarBlock) {
      const declMatch = trimmed.match(/^(\w+)\s*:\s*([^;:=]+?)(?:\s*:=\s*(.+?))?\s*;?\s*$/);
      if (declMatch) {
        const [, varName, varType, initVal] = declMatch;
        const device = allocator.allocate(varName, varType.trim());
        const initPart = initVal ? ` := ${initVal}` : "";
        outputLines.push(`${indent}${varName} AT ${device} : ${varType.trim()}${initPart};`);
        translatedNodes++;
        continue;
      }
      outputLines.push(line);
      continue;
    }

    // Check for untranslatable instructions
    let wasUntranslatable = false;
    for (const [funcName, info] of Object.entries(UNTRANSLATABLE)) {
      const regex = new RegExp(`\\b${funcName}\\s*\\(`);
      if (regex.test(trimmed)) {
        diagnostics.push({ severity: "MANUAL_PORT", code: info.code, message: info.message, line: lineNum });
        outputLines.push(`${indent}(* MANUAL PORT REQUIRED: ${funcName} block from ${sourceFile}:${lineNum}`);
        outputLines.push(`${indent}   Original call: ${trimmed}`);
        outputLines.push(`${indent}   ${info.message}`);
        outputLines.push(`${indent}*)`);
        translatedNodes++;
        wasUntranslatable = true;
        break;
      }
    }
    if (wasUntranslatable) continue;

    // Timer rewriting: TON(instance) → instance(IN := ..., PT := ...)
    const timerMatch = trimmed.match(/^(TON|TOF|RTO|TONR)\s*\((\w+)\)\s*;?\s*$/);
    if (timerMatch) {
      const [, timerType, instance] = timerMatch;
      outputLines.push(`${indent}// [AB→MEL] src: ${sourceFile} line ${lineNum} | orig: "${trimmed}"`);
      outputLines.push(`${indent}${instance}(IN := ${instance}_EN, PT := ${instance}_PT);`);
      if (timerType === "RTO" || timerType === "TONR") {
        diagnostics.push({ severity: "WARN", code: "AB_MEL_TIMER_001", message: `Retentive timer ${instance} — verify reset path on MEL side.`, line: lineNum });
      }
      translatedNodes++;
      continue;
    }

    // Counter rewriting: CTU(instance) → instance(CU := ..., PV := ...)
    const ctrMatch = trimmed.match(/^(CTU|CTD|CTUD)\s*\((\w+)\)\s*;?\s*$/);
    if (ctrMatch) {
      const [, ctrType, instance] = ctrMatch;
      outputLines.push(`${indent}// [AB→MEL] src: ${sourceFile} line ${lineNum} | orig: "${trimmed}"`);
      if (ctrType === "CTU") outputLines.push(`${indent}${instance}(CU := ${instance}_CU, R := ${instance}_R, PV := ${instance}_PV);`);
      else if (ctrType === "CTD") outputLines.push(`${indent}${instance}(CD := ${instance}_CD, LD := ${instance}_LD, PV := ${instance}_PV);`);
      else outputLines.push(`${indent}${instance}(CU := ${instance}_CU, CD := ${instance}_CD, R := ${instance}_R, PV := ${instance}_PV);`);
      translatedNodes++;
      continue;
    }

    // Statement-level translations with provenance
    let translated = line;
    let didTranslate = false;

    // Timer/counter member rewrites
    if (/\.\b(DN|TT|PRE|ACC)\b/.test(translated)) {
      translated = translated.replace(/\.DN\b/g, ".Q");
      translated = translated.replace(/\.TT\b/g, ".Q");
      translated = translated.replace(/\.PRE\b/g, ".PT");
      translated = translated.replace(/\.ACC\b/g, ".ET");
      didTranslate = true;
    }

    // Power operator ** → EXPT()
    if (/\w+\s*\*\*\s*\w+/.test(translated) && !translated.includes("(*")) {
      translated = translated.replace(/(\w+)\s*\*\*\s*(\w+)/g, "EXPT($1, $2)");
      didTranslate = true;
    }

    // Array indexing [i][j] → [i, j]
    if (/\]\s*\[/.test(translated)) {
      translated = translated.replace(/\]\s*\[/g, ", ");
      didTranslate = true;
    }

    if (didTranslate) {
      outputLines.push(`${indent}// [AB→MEL] src: ${sourceFile} line ${lineNum} | orig: "${trimmed}"`);
      outputLines.push(translated);
      translatedNodes++;
    } else {
      // Pass through unchanged but still count as processed
      outputLines.push(translated);
      if (trimmed.includes(":=") || /^(IF|ELSIF|ELSE|END_IF|FOR|END_FOR|WHILE|END_WHILE|REPEAT|UNTIL|END_REPEAT|CASE|END_CASE|EXIT)\b/i.test(trimmed)) {
        translatedNodes++;
      }
    }
  }

  // Warn if no nodes translated
  if (translatedNodes === 0) {
    diagnostics.push({ severity: "WARN", code: "AB_MEL_PIPELINE_001", message: "Pipeline produced no translated nodes — likely parser failure or empty input.", line: 0 });
  }

  return { output: outputLines.join("\n"), allocator, translatedNodes };
}

// === MEL → AB ===

function translateMELtoAB(source: string, diagnostics: Diagnostic[], sourceFile: string): {
  output: string; translatedNodes: number;
} {
  const lines = source.split("\n");
  const outputLines: string[] = [];
  let translatedNodes = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();
    const indent = line.match(/^(\s*)/)?.[1] || "";

    if (!trimmed) { outputLines.push(""); continue; }
    if (trimmed.startsWith("//") || trimmed.startsWith("(*")) { outputLines.push(line); continue; }

    // RETURN → warn
    if (/^RETURN\s*;?\s*$/i.test(trimmed)) {
      diagnostics.push({ severity: "WARN", code: "AB_MEL_EMIT_001", message: "RETURN not supported in AB ST. Restructure as IF wrapper.", line: lineNum });
      outputLines.push(`${indent}// [MEL→AB] RETURN not supported — wrap remaining code in IF`);
      translatedNodes++;
      continue;
    }

    // MEL FB invocation → AB style
    const fbMatch = trimmed.match(/^(\w+)\s*\((?:IN|CU|CD)\s*:=\s*.+\)\s*;?\s*$/);
    if (fbMatch) {
      const instance = fbMatch[1];
      outputLines.push(`${indent}// [MEL→AB] src: ${sourceFile} line ${lineNum} | orig: "${trimmed}"`);
      if (trimmed.includes("IN :=") && trimmed.includes("PT :=")) {
        outputLines.push(`${indent}TON(${instance});`);
      } else if (trimmed.includes("CU :=")) {
        outputLines.push(`${indent}CTU(${instance});`);
      } else if (trimmed.includes("CD :=")) {
        outputLines.push(`${indent}CTD(${instance});`);
      } else {
        outputLines.push(line);
      }
      translatedNodes++;
      continue;
    }

    // Member rewrites
    let translated = line;
    let didTranslate = false;

    if (/\.\b(Q|PT|ET|PV|CV)\b/.test(translated)) {
      translated = translated.replace(/\.Q\b/g, ".DN");
      translated = translated.replace(/\.PT\b/g, ".PRE");
      translated = translated.replace(/\.ET\b/g, ".ACC");
      translated = translated.replace(/\.PV\b/g, ".PRE");
      translated = translated.replace(/\.CV\b/g, ".ACC");
      didTranslate = true;
    }

    // Remove AT addresses
    if (/\s+AT\s+[A-Z]+\d+/.test(translated)) {
      translated = translated.replace(/\s+AT\s+[A-Z]+\d+/g, "");
      didTranslate = true;
    }

    // EXPT() → **
    if (/EXPT\s*\(/.test(translated)) {
      translated = translated.replace(/EXPT\s*\((\w+),\s*(\w+)\)/g, "$1 ** $2");
      didTranslate = true;
    }

    // Array [i, j] → [i][j]
    if (/\[[^\]]+,\s*[^\]]+\]/.test(translated)) {
      translated = translated.replace(/\[([^\],]+),\s*([^\]]+)\]/g, "[$1][$2]");
      didTranslate = true;
    }

    // Device references → tag names
    const devicePattern = /\b(ST\d+|[XYMLBFSDWRTCZV]\d+)\b/g;
    let devMatch;
    const devices: string[] = [];
    while ((devMatch = devicePattern.exec(translated)) !== null) {
      const idx = devMatch.index;
      if (idx > 0 && /[a-zA-Z_]/.test(translated[idx - 1])) continue;
      devices.push(devMatch[1]);
    }
    for (const dev of [...new Set(devices)]) {
      translated = translated.replace(new RegExp(`\\b${dev}\\b`, "g"), `${dev}_Tag`);
      didTranslate = true;
    }

    if (didTranslate) {
      outputLines.push(`${indent}// [MEL→AB] src: ${sourceFile} line ${lineNum} | orig: "${trimmed}"`);
      outputLines.push(translated);
      translatedNodes++;
    } else {
      outputLines.push(translated);
      if (trimmed.includes(":=") || /^(IF|ELSIF|ELSE|END_IF|FOR|END_FOR|WHILE|END_WHILE|REPEAT|UNTIL|END_REPEAT|CASE|END_CASE|EXIT)\b/i.test(trimmed)) {
        translatedNodes++;
      }
    }
  }

  if (translatedNodes === 0) {
    diagnostics.push({ severity: "WARN", code: "AB_MEL_PIPELINE_001", message: "Pipeline produced no translated nodes — likely parser failure or empty input.", line: 0 });
  }

  return { output: outputLines.join("\n"), translatedNodes };
}

// === Main entry ===

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

  const outputLines = output.split("\n").length;
  return {
    ok: !diagnostics.some(d => d.severity === "ERROR"),
    output,
    diagnostics,
    mappingYaml,
    labelsCsv,
    stats: {
      inputLines,
      outputLines,
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
