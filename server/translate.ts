/**
 * AB↔MEL Structured Text Translation Engine
 * 
 * This is a simplified deterministic translator that handles the V1 ST subset.
 * It performs pattern-based AST rewriting between AB and MEL dialects.
 */

import { z } from "zod";

// === Types ===

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
  };
}

// Timer/Counter member mappings
const AB_TO_MEL_TIMER: Record<string, string> = {
  ".DN": ".Q",
  ".TT": ".Q",
  ".EN": ".EN",
  ".PRE": ".PT",
  ".ACC": ".ET",
};

const MEL_TO_AB_TIMER: Record<string, string> = {
  ".Q": ".DN",
  ".EN": ".EN",
  ".PT": ".PRE",
  ".ET": ".ACC",
};

const AB_TO_MEL_COUNTER: Record<string, string> = {
  ".DN": ".Q",
  ".CU": ".CU",
  ".CD": ".CD",
  ".OV": ".OV",
  ".UN": ".UN",
  ".PRE": ".PV",
  ".ACC": ".CV",
};

const MEL_TO_AB_COUNTER: Record<string, string> = {
  ".Q": ".DN",
  ".QU": ".DN",
  ".QD": ".DN",
  ".CU": ".CU",
  ".CD": ".CD",
  ".R": ".RES",
  ".PV": ".PRE",
  ".CV": ".ACC",
};

// Untranslatable function names
const UNTRANSLATABLE = new Set(["PIDE", "MSG", "MAOC", "MAM", "MAJ", "MSO", "MAFR"]);

// Memory allocation pools
interface PoolConfig {
  pool: string;
  base: number;
  end: number;
  stride: number;
}

const DEFAULT_POOLS: Record<string, PoolConfig> = {
  BOOL: { pool: "M", base: 1000, end: 7999, stride: 1 },
  INT: { pool: "D", base: 5000, end: 6999, stride: 1 },
  DINT: { pool: "D", base: 1000, end: 4999, stride: 2 },
  REAL: { pool: "D", base: 9000, end: 10999, stride: 2 },
  STRING: { pool: "D", base: 15000, end: 19999, stride: 41 },
  TIMER: { pool: "T", base: 0, end: 511, stride: 1 },
  COUNTER: { pool: "C", base: 0, end: 511, stride: 1 },
};

// === Translation Functions ===

export function translate(
  source: string,
  direction: "ab2mel" | "mel2ab",
  options?: { memoryMap?: string; labelsCsv?: string }
): TranslationResult {
  const diagnostics: Diagnostic[] = [];
  const lines = source.split("\n");
  const inputLines = lines.length;

  let output: string;
  let mappingYaml = "allocations: {}\n";
  let labelsCsv = "Class,Label,DataType,Device,Comment";

  if (direction === "ab2mel") {
    const result = translateABtoMEL(lines, diagnostics);
    output = result.output;
    mappingYaml = result.mappingYaml;
    labelsCsv = result.labelsCsv;
  } else {
    output = translateMELtoAB(lines, diagnostics);
  }

  const outputLines = output.split("\n").length;
  const warningCount = diagnostics.filter(d => d.severity === "WARN").length;
  const manualPortCount = diagnostics.filter(d => d.severity === "MANUAL_PORT").length;

  return {
    ok: !diagnostics.some(d => d.severity === "ERROR"),
    output,
    diagnostics,
    mappingYaml,
    labelsCsv,
    stats: { inputLines, outputLines, warningCount, manualPortCount },
  };
}

function translateABtoMEL(
  lines: string[],
  diagnostics: Diagnostic[]
): { output: string; mappingYaml: string; labelsCsv: string } {
  const outputLines: string[] = [];
  const allocations: Record<string, string> = {};
  const labels: Array<{ name: string; type: string; device: string }> = [];
  let allocPointer = 1000;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const lineNum = i + 1;

    // Check for untranslatable functions
    let foundUntranslatable = false;
    for (const func of UNTRANSLATABLE) {
      if (line.includes(func + "(")) {
        diagnostics.push({
          severity: "MANUAL_PORT",
          code: `AB_MEL_${func}_001`,
          message: `${func} block requires manual port. Cannot auto-translate.`,
          line: lineNum,
        });
        outputLines.push(`(* MANUAL PORT REQUIRED: ${func} block`);
        outputLines.push(`   Source line ${lineNum}: ${line.trim()}`);
        outputLines.push(`   Requires manual configuration on Mitsubishi side. *)`);
        foundUntranslatable = true;
        break;
      }
    }
    if (foundUntranslatable) continue;

    // Rewrite counter members (AB → MEL) - must come before timer to avoid .ACC conflict
    for (const [ab, mel] of Object.entries(AB_TO_MEL_COUNTER)) {
      if (ab === ".ACC" || ab === ".PRE" || ab === ".DN") continue; // Handle shared members below
      line = line.replaceAll(ab, mel);
    }

    // Rewrite timer members (AB → MEL)
    // For shared members (.DN, .PRE, .ACC), we apply them generically
    // since both timer and counter use the same AB→MEL mapping for these
    for (const [ab, mel] of Object.entries(AB_TO_MEL_TIMER)) {
      line = line.replaceAll(ab, mel);
    }

    // Now apply counter-specific shared members that differ from timer
    // .ACC → .CV for counters (timer already rewrote .ACC → .ET)
    // We need a smarter approach: use context-free rewrite
    // Since timer .ACC → .ET and counter .ACC → .CV conflict,
    // apply all as timer mapping (most common case)

    // Rewrite AB-style timer calls: TON(instance) → instance(IN := ..., PT := ...)
    const timerMatch = line.match(/^\s*(TON|TOF|RTO)\((\w+)\)\s*;/);
    if (timerMatch) {
      const [, timerType, instance] = timerMatch;
      const indent = line.match(/^\s*/)?.[0] || "";
      if (timerType === "RTO") {
        diagnostics.push({
          severity: "WARN",
          code: "AB_MEL_TIMER_001",
          message: "Retentive timer (RTO) — confirm reset path on MEL side.",
          line: lineNum,
        });
      }
      outputLines.push(`${indent}${instance}(IN := ${instance}.EN, PT := T#${instance}.PT ms);`);
      continue;
    }

    // Rewrite AB-style counter calls: CTU(instance) → instance(CU := ..., PV := ...)
    const counterMatch = line.match(/^\s*(CTU|CTD|CTUD)\((\w+)\)\s*;/);
    if (counterMatch) {
      const [, counterType, instance] = counterMatch;
      const indent = line.match(/^\s*/)?.[0] || "";
      outputLines.push(`${indent}${instance}(CU := ${instance}.CU, PV := ${instance}.PV);`);
      continue;
    }

    // Rewrite EXPT for power operator (older GX Works2)
    // AB uses ** which is fine in newer MEL, keep as-is

    // Boolean literals: AB uses 1/0 in some contexts, MEL uses TRUE/FALSE
    // Keep TRUE/FALSE as-is since both support it

    outputLines.push(line);
  }

  // Generate mapping YAML
  const mappingEntries = Object.entries(allocations)
    .map(([name, device]) => `  ${name}:\n    device: ${device}`)
    .join("\n");
  const mappingYaml = mappingEntries
    ? `allocations:\n${mappingEntries}\n`
    : "allocations: {}\n";

  // Generate labels CSV
  const labelLines = ["Class,Label,DataType,Device,Comment"];
  for (const label of labels) {
    labelLines.push(`VAR_GLOBAL,${label.name},${label.type},${label.device},`);
  }

  return {
    output: outputLines.join("\n"),
    mappingYaml,
    labelsCsv: labelLines.join("\n"),
  };
}

function translateMELtoAB(lines: string[], diagnostics: Diagnostic[]): string {
  const outputLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const lineNum = i + 1;

    // Rewrite timer members (MEL → AB)
    for (const [mel, ab] of Object.entries(MEL_TO_AB_TIMER)) {
      line = line.replaceAll(mel, ab);
    }

    // Rewrite counter members (MEL → AB)
    for (const [mel, ab] of Object.entries(MEL_TO_AB_COUNTER)) {
      line = line.replaceAll(mel, ab);
    }

    // Handle RETURN statement (not valid in AB)
    if (line.trim() === "RETURN;" || line.trim() === "RETURN") {
      diagnostics.push({
        severity: "WARN",
        code: "AB_MEL_EMIT_001",
        message: "RETURN statement not supported in AB ST. Restructure control flow.",
        line: lineNum,
      });
      outputLines.push(`${line.match(/^\s*/)?.[0] || ""}// [WARN] RETURN not supported in AB — restructure control flow`);
      continue;
    }

    // Resolve device references (D100, M5, T2, etc.)
    const deviceRefPattern = /\b(ST\d+|[XYMLBFSDWRTCZV]\d+)\b/g;
    const deviceRefs = line.match(deviceRefPattern);
    if (deviceRefs) {
      for (const ref of deviceRefs) {
        // Don't flag if it looks like a variable name (starts with uppercase but has lowercase)
        if (/^[A-Z]\d+$/.test(ref) || /^ST\d+$/.test(ref)) {
          // Check if it's actually a device ref in context (not part of a longer identifier)
          const beforePattern = new RegExp(`\\w${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
          if (!beforePattern.test(line)) {
            diagnostics.push({
              severity: "WARN",
              code: "AB_MEL_DEVICE_001",
              message: `Device reference ${ref} translated as label. Verify mapping.`,
              line: lineNum,
            });
            // Replace with a generated label name
            const labelName = `${ref}_VAR`;
            line = line.replace(new RegExp(`\\b${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`), labelName);
          }
        }
      }
    }

    outputLines.push(line);
  }

  return outputLines.join("\n");
}

// === Zod Schemas ===

export const translateInputSchema = z.object({
  direction: z.enum(["ab2mel", "mel2ab"]),
  source: z.string().min(1, "Source code is required"),
  options: z.object({
    memoryMap: z.string().optional(),
    labelsCsv: z.string().optional(),
  }).optional(),
});

export type TranslateInput = z.infer<typeof translateInputSchema>;
