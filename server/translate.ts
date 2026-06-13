/**
 * AB↔MEL Structured Text Translation — Pipeline Entry Point
 * 
 * Pipeline stages wrapped in try/catch. On exception, produces a structured
 * failure report rather than HTTP 500.
 */

import { z } from "zod";
import { parseSTSource } from "./compiler/parser";
import { emitMEL } from "./compiler/emitter";
import { emitAB } from "./compiler/emitter-ab";
import { looksLikeL5K, extractL5K, joinExtractedRoutines } from "./compiler/l5k_extract";

export interface Diagnostic {
  severity: "INFO" | "WARN" | "MANUAL_PORT" | "ERROR";
  code: string;
  message: string;
  line: number;
}

export interface FailureReport {
  stage: string;
  error: string;
  traceback: string;
  sourceContext: string;
  pipelineState: string;
  timestamp: string;
  direction: string;
  inputLines: number;
}

export interface TranslationResult {
  ok: boolean;
  output: string;
  diagnostics: Diagnostic[];
  mappingYaml: string;
  labelsCsv: string;
  failureReport: FailureReport | null;
  stats: {
    inputLines: number;
    outputLines: number;
    warningCount: number;
    manualPortCount: number;
    translatedNodes: number;
  };
}

function buildSourceContext(source: string, errorLine: number): string {
  const lines = source.split("\n");
  const start = Math.max(0, errorLine - 4);
  const end = Math.min(lines.length, errorLine + 3);
  const contextLines: string[] = [];
  for (let i = start; i < end; i++) {
    const lineNum = (i + 1).toString().padStart(4, " ");
    const prefix = (i + 1 === errorLine) ? ">>>" : "   ";
    contextLines.push(`${prefix} ${lineNum} | ${lines[i]}`);
  }
  return contextLines.join("\n");
}

function extractErrorLine(error: Error, source: string): number {
  // Try to extract line number from error message
  const lineMatch = error.message.match(/line (\d+)/i);
  if (lineMatch) return parseInt(lineMatch[1]);
  // Try stack trace for position info
  const posMatch = error.message.match(/position (\d+)/i);
  if (posMatch) {
    const pos = parseInt(posMatch[1]);
    const upToPos = source.substring(0, pos);
    return (upToPos.match(/\n/g) || []).length + 1;
  }
  return 1;
}

function formatFailureReport(report: FailureReport): string {
  return `=== FAILURE REPORT ===
timestamp: ${report.timestamp}
direction: ${report.direction}
stage: ${report.stage}
input_lines: ${report.inputLines}

--- ERROR ---
${report.error}

--- TRACEBACK ---
${report.traceback}

--- SOURCE CONTEXT ---
${report.sourceContext}

--- PIPELINE STATE ---
${report.pipelineState}

=== END REPORT ===`;
}

export function translate(
  source: string,
  direction: "ab2mel" | "mel2ab",
  options?: { memoryMap?: string; labelsCsv?: string }
): TranslationResult {
  const diagnostics: Diagnostic[] = [];
  const timestamp = new Date().toISOString();

  // ── L5K pre-extraction ────────────────────────────────────────────────
  // Studio 5000 L5K exports are not raw ST — they wrap controller config,
  // tags, programs, and AOIs in a Pascal-flavored DSL with ST routines
  // buried in `ST_ROUTINE ... END_ST_ROUTINE` blocks. Detect L5K input and
  // extract the ST source before handing off to the parser.
  if (direction === "ab2mel" && looksLikeL5K(source)) {
    const extracted = extractL5K(source);
    if (extracted.stRoutines.length === 0) {
      const inputLines = source.split("\n").length;
      return {
        ok: false,
        output: "",
        diagnostics: [
          {
            severity: "ERROR",
            code: "AB_MEL_L5K_001",
            message: `L5K file recognized (controller: ${extracted.controllerName ?? "<unknown>"}, IE_VER ${extracted.ieVer ?? "?"}) but contains no ST_ROUTINE blocks. Found ${extracted.ladderRoutines.length} ladder routine(s) — those are RLL, not Structured Text. Convert ladder to ST in Studio 5000 first, or paste a routine that's already ST.`,
            line: 1,
          },
        ],
        mappingYaml: "allocations: {}\n",
        labelsCsv: "Class,Label,DataType,Device,Comment",
        failureReport: {
          stage: "l5k_extract",
          error: "L5K contains no ST routines",
          traceback: `Found ${extracted.ladderRoutines.length} RLL routines; 0 ST routines`,
          sourceContext: source.split("\n").slice(0, 8).join("\n"),
          pipelineState: `L5K detected, no ST extractable`,
          timestamp,
          direction,
          inputLines,
        },
        stats: { inputLines, outputLines: 0, warningCount: 0, manualPortCount: 0, translatedNodes: 0 },
      };
    }
    // Replace source with joined ST routines and continue. Diagnostics
    // about the extraction itself get prepended.
    source = joinExtractedRoutines(extracted);
    diagnostics.push({
      severity: "INFO",
      code: "AB_MEL_L5K_002",
      message: `L5K extracted: ${extracted.stRoutines.length} ST routine(s) from controller "${extracted.controllerName ?? "<unknown>"}". ${extracted.ladderRoutines.length} ladder routine(s) skipped (RLL, not ST).`,
      line: 1,
    });
  }

  const sourceLines = source.split("\n");
  const inputLines = sourceLines.length;
  const sourceFile = "<input>";

  // Pipeline state tracking
  let currentStage = "init";
  let ast: any = null;

  // === Stage: parse ===
  currentStage = "parser";
  try {
    ast = parseSTSource(source);
  } catch (err: any) {
    const errorLine = extractErrorLine(err, source);
    const report: FailureReport = {
      stage: "parser",
      error: err.message,
      traceback: err.stack || err.message,
      sourceContext: buildSourceContext(source, errorLine),
      pipelineState: "AST: not produced (parse failed)",
      timestamp,
      direction,
      inputLines,
    };
    diagnostics.push({
      severity: "ERROR",
      code: "AB_MEL_PARSE_001",
      message: `Parse error at line ${errorLine}: ${err.message}`,
      line: errorLine,
    });
    return {
      ok: false,
      output: "",
      diagnostics,
      mappingYaml: "allocations: {}\n",
      labelsCsv: "Class,Label,DataType,Device,Comment",
      failureReport: report,
      stats: { inputLines, outputLines: 0, warningCount: 0, manualPortCount: 0, translatedNodes: 0 },
    };
  }

  // === Stage: emit (includes cst_to_ir, typecheck, lower_*, allocate_memory, emit_mel/emit_ab) ===
  currentStage = direction === "ab2mel" ? "emit_mel" : "emit_ab";
  try {
    if (direction === "ab2mel") {
      const result = emitMEL(ast, sourceFile, sourceLines);
      // Check for ERROR diagnostics or empty output
      const hasErrors = result.diagnostics.some(d => d.severity === "ERROR");
      const emptyOutput = result.translatedNodes === 0 && inputLines > 1;
      let failureReport: FailureReport | null = null;
      if (emptyOutput && !hasErrors) {
        failureReport = {
          stage: "emit_mel",
          error: "Pipeline produced 0 translated nodes for non-empty input. Parser may not recognize this input format.",
          traceback: "No exception — translatedNodes counter is 0",
          sourceContext: buildSourceContext(source, 1),
          pipelineState: `AST: ${ast.length} top-level nodes\ntranslatedNodes: 0\noutputLines: ${result.output.split("\n").length}`,
          timestamp,
          direction,
          inputLines,
        };
        result.diagnostics.push({ severity: "ERROR", code: "AB_MEL_PIPELINE_002", message: "No nodes translated. Input may not be Structured Text.", line: 0 });
      }
      if (hasErrors) {
        const firstError = result.diagnostics.find(d => d.severity === "ERROR")!;
        failureReport = {
          stage: "emit_mel",
          error: firstError.message,
          traceback: `Diagnostic ERROR at line ${firstError.line}: ${firstError.code}`,
          sourceContext: buildSourceContext(source, firstError.line),
          pipelineState: `AST: ${ast.length} top-level nodes produced\nEmit: partial output (${result.output.split("\n").length} lines before error)`,
          timestamp,
          direction,
          inputLines,
        };
      }
      return {
        ok: !hasErrors,
        output: result.output,
        diagnostics: [...diagnostics, ...result.diagnostics],
        mappingYaml: result.mappingYaml,
        labelsCsv: result.labelsCsv,
        failureReport,
        stats: {
          inputLines,
          outputLines: result.output.split("\n").length,
          warningCount: result.diagnostics.filter(d => d.severity === "WARN").length,
          manualPortCount: result.diagnostics.filter(d => d.severity === "MANUAL_PORT").length,
          translatedNodes: result.translatedNodes,
        },
      };
    } else {
      // MEL → AB via real emitter (was previously string regex replacement).
      const result = emitAB(ast, sourceFile, sourceLines);
      const hasErrors = result.diagnostics.some(d => d.severity === "ERROR");
      let failureReport: FailureReport | null = null;
      if (result.translatedNodes === 0 && inputLines > 1 && !hasErrors) {
        failureReport = {
          stage: "emit_ab",
          error: "Pipeline produced 0 translated nodes for non-empty input. Parser may not recognize this input format.",
          traceback: "No exception — translatedNodes counter is 0",
          sourceContext: buildSourceContext(source, 1),
          pipelineState: `AST: ${ast.length} top-level nodes\ntranslatedNodes: 0\noutputLines: ${result.output.split("\n").length}`,
          timestamp,
          direction,
          inputLines,
        };
        result.diagnostics.push({ severity: "ERROR", code: "MEL_AB_PIPELINE_002", message: "No nodes translated. Input may not be Structured Text.", line: 0 });
      }
      return {
        ok: !hasErrors && !failureReport,
        output: result.output,
        diagnostics: result.diagnostics,
        mappingYaml: result.mappingYaml,
        labelsCsv: result.labelsCsv,
        failureReport,
        stats: {
          inputLines,
          outputLines: result.output.split("\n").length,
          warningCount: result.diagnostics.filter(d => d.severity === "WARN").length,
          manualPortCount: result.diagnostics.filter(d => d.severity === "MANUAL_PORT").length,
          translatedNodes: result.translatedNodes,
        },
      };
    }
  } catch (err: any) {
    const errorLine = extractErrorLine(err, source);
    const report: FailureReport = {
      stage: currentStage,
      error: err.message,
      traceback: err.stack || err.message,
      sourceContext: buildSourceContext(source, errorLine),
      pipelineState: `AST: ${ast ? ast.length + " top-level nodes" : "null"}\nStage failed: ${currentStage}`,
      timestamp,
      direction,
      inputLines,
    };
    diagnostics.push({
      severity: "ERROR",
      code: "AB_MEL_EMIT_ERR",
      message: `${currentStage} failed: ${err.message}`,
      line: errorLine,
    });
    return {
      ok: false,
      output: "",
      diagnostics,
      mappingYaml: "allocations: {}\n",
      labelsCsv: "Class,Label,DataType,Device,Comment",
      failureReport: report,
      stats: { inputLines, outputLines: 0, warningCount: 0, manualPortCount: 0, translatedNodes: 0 },
    };
  }
}

// Export the formatter for use in the UI
export { formatFailureReport };

export const translateInputSchema = z.object({
  direction: z.enum(["ab2mel", "mel2ab"]),
  source: z.string().min(1, "Source code is required"),
  options: z.object({ memoryMap: z.string().optional(), labelsCsv: z.string().optional() }).optional(),
});
export type TranslateInput = z.infer<typeof translateInputSchema>;
