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
import { emitLabelsCsv, emitUdtSummary } from "./compiler/labels_emitter";
import { emitIoMapYaml } from "./compiler/module_emitter";
import { emitAoiAsFb, groupRoutinesByAoi } from "./compiler/aoi_emitter";
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
  /** ST FUNCTION_BLOCK definitions for AOIs extracted from L5K (Phase 2). */
  fbDefinitions: string;
  /** UDT (Structured Data Type) definitions from L5K (Phase 2). */
  udtDefinitions: string;
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
  // L5K exports route through a separate path: extract routines, then
  // process each routine independently. ST routines flow through the
  // standard ST→MEL pipeline; ladder routines go through the ladder
  // emitter which already produces MEL-compatible ST. Re-parsing
  // ladder-emitted ST through the strict ST parser is unnecessary and
  // causes failures on edge cases the ST parser doesn't handle.
  if (direction === "ab2mel" && looksLikeL5K(source)) {
    return translateL5K(source, timestamp, direction, options);
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
      fbDefinitions: "",
      udtDefinitions: "",
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
        fbDefinitions: "",
        udtDefinitions: "",
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
        fbDefinitions: "",
        udtDefinitions: "",
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
      fbDefinitions: "",
      udtDefinitions: "",
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
/**
 * L5K-specific translation path. Splits ST routines and ladder routines into
 * separate processing streams, then concatenates outputs.
 *
 * ST routines run through the full ST→MEL pipeline (parser + emitter) so
 * they get proper instruction rewrites (ABS→ABS, COP→BMOV, etc.).
 *
 * Ladder routines run through the ladder emitter only, which produces
 * MEL-compatible ST directly. Re-parsing ladder-emitted ST through the
 * strict ST parser is avoided because the ladder emitter sometimes
 * produces constructs the ST parser doesn't (yet) handle, and the
 * ladder emitter already targets MEL conventions.
 */
function translateL5K(
  source: string,
  timestamp: string,
  direction: "ab2mel" | "mel2ab",
  _options?: { memoryMap?: string; labelsCsv?: string }
): TranslationResult {
  const inputLines = source.split("\n").length;
  const diagnostics: Diagnostic[] = [];
  const extracted = extractL5K(source);
  if (extracted.stRoutines.length === 0 && extracted.ladderRoutines.length === 0) {
    return {
      ok: false,
      output: "",
      diagnostics: [
        {
          severity: "ERROR",
          code: "AB_MEL_L5K_001",
          message: `L5K file recognized (controller: ${extracted.controllerName ?? "<unknown>"}, IE_VER ${extracted.ieVer ?? "?"}) but contains no translatable routines.`,
          line: 1,
        },
      ],
      mappingYaml: "allocations: {}\n",
      labelsCsv: "Class,Label,DataType,Device,Comment",
      fbDefinitions: "",
      udtDefinitions: "",
      failureReport: {
        stage: "l5k_extract",
        error: "L5K contains no routines",
        traceback: "",
        sourceContext: source.split("\n").slice(0, 8).join("\n"),
        pipelineState: `L5K detected, no routines extractable`,
        timestamp,
        direction,
        inputLines,
      },
      stats: { inputLines, outputLines: 0, warningCount: 0, manualPortCount: 0, translatedNodes: 0 },
    };
  }
  // Lazy-import to avoid pulling ladder_emitter unless we need it
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { emitLadderRoutine } = require("./compiler/ladder_emitter");
  const outChunks: string[] = [];
  outChunks.push(
    `(* L5K extraction from controller "${extracted.controllerName ?? "<unknown>"}" (IE_VER ${extracted.ieVer ?? "?"}) *)`,
  );
  outChunks.push(
    `(*   ${extracted.stRoutines.length} ST routine(s) + ${extracted.ladderRoutines.length} ladder routine(s) *)`,
  );
  outChunks.push(
    `(*   ${extracted.aois.length} AOI(s) → emitted as FUNCTION_BLOCK definitions (see FB tab) *)`,
  );
  outChunks.push(
    `(*   ${extracted.tags.length} controller tag(s) → labels CSV (see Labels tab) *)`,
  );
  outChunks.push(
    `(*   ${extracted.modules.length} IO module(s) → mapping YAML (see Mapping tab) *)`,
  );
  outChunks.push("");
  let translatedNodes = 0;
  let stRoutinesOk = 0;
  let stRoutinesFailed = 0;
  let ladderRoutinesOk = 0;
  let ladderRungsTotal = 0;
  let ladderRungsFailed = 0;
  const manualPortSet = new Set<string>();
  // Per-routine translated body. Key format: `<KIND>:<PARENT>/<NAME>` where
  // KIND is "AOI" / "PROGRAM" / "TASK" / "TOPLEVEL".
  const routineBodies = new Map<string, string>();
  const keyFor = (parentKind: string | null, parentName: string, name: string) =>
    `${parentKind ?? "TOPLEVEL"}:${parentName}/${name}`;
  // ─── Translate every ST routine, store body in routineBodies ───────
  for (const r of extracted.stRoutines) {
    const parent = r.parentKind ? `${r.parentKind.toLowerCase()} ${r.parentName}` : "<top-level>";
    try {
      const ast = parseSTSource(r.source);
      const lines = r.source.split("\n");
      const result = emitMEL(ast, `<L5K:${parent}/${r.name}>`, lines);
      routineBodies.set(keyFor(r.parentKind, r.parentName, r.name), result.output);
      translatedNodes += result.translatedNodes;
      for (const d of result.diagnostics) {
        diagnostics.push({ ...d, message: `[${parent}/${r.name}] ${d.message}` });
        if (d.severity === "MANUAL_PORT") manualPortSet.add("st_manual_port");
      }
      stRoutinesOk++;
    } catch (err: any) {
      routineBodies.set(keyFor(r.parentKind, r.parentName, r.name),
        `(* Parse failed for ${parent}/${r.name}: ${err.message} *)`);
      stRoutinesFailed++;
      diagnostics.push({
        severity: "ERROR",
        code: "AB_MEL_L5K_ST_001",
        message: `ST routine ${parent}/${r.name} failed to parse: ${err.message}`,
        line: r.sourceStartLine,
      });
    }
  }
  // ─── Translate every ladder routine, store body in routineBodies ───
  for (const r of extracted.ladderRoutines) {
    const parent = r.parentKind ? `${r.parentKind.toLowerCase()} ${r.parentName}` : "<top-level>";
    if (r.rungs.length === 0) {
      routineBodies.set(keyFor(r.parentKind, r.parentName, r.name), "(* empty routine *)");
      ladderRoutinesOk++;
      continue;
    }
    const ladderOut = emitLadderRoutine(r.rungs);
    routineBodies.set(keyFor(r.parentKind, r.parentName, r.name), ladderOut.st);
    ladderRoutinesOk++;
    ladderRungsTotal += ladderOut.rungCount;
    ladderRungsFailed += ladderOut.failedRungCount;
    translatedNodes += (ladderOut.rungCount - ladderOut.failedRungCount);
    for (const mp of ladderOut.manualPortInstructions) manualPortSet.add(mp);
    if (ladderOut.warnings.length > 0) {
      diagnostics.push({
        severity: "WARN",
        code: "AB_MEL_LADDER_WARN",
        message: `${parent}/${r.name}: ${ladderOut.warnings.length} warning(s) — ${ladderOut.warnings[0]}`,
        line: r.sourceStartLine,
      });
    }
  }
  // ─── Main output: PROGRAM/TASK/top-level routines ──────────────────
  // AOI routines are emitted in fbDefinitions, not here.
  const emitRoutineInMain = (parentKind: string | null, parentName: string, name: string,
                              kindLabel: string, sourceStartLine: number, ruleCount?: number) => {
    const parent = parentKind ? `${parentKind.toLowerCase()} ${parentName}` : "<top-level>";
    const suffix = ruleCount !== undefined ? `, ${ruleCount} rungs` : "";
    outChunks.push(`(* ── ${kindLabel} ${name} in ${parent} (L5K line ${sourceStartLine}${suffix}) ── *)`);
    const body = routineBodies.get(keyFor(parentKind, parentName, name)) ?? "(* missing *)";
    outChunks.push(body);
    outChunks.push("");
  };
  for (const r of extracted.stRoutines) {
    if (r.parentKind === "AOI") continue;
    emitRoutineInMain(r.parentKind, r.parentName, r.name, "ST_ROUTINE", r.sourceStartLine);
  }
  for (const r of extracted.ladderRoutines) {
    if (r.parentKind === "AOI") continue;
    emitRoutineInMain(r.parentKind, r.parentName, r.name, "ROUTINE (ladder→ST)", r.sourceStartLine, r.ruleCount);
  }
  // ─── FB definitions: wrap AOIs ─────────────────────────────────────
  const fbChunks: string[] = [];
  fbChunks.push(`(* AOI → FUNCTION_BLOCK definitions extracted from L5K *)`);
  fbChunks.push(`(*   Controller: ${extracted.controllerName ?? "<unknown>"}, ${extracted.aois.length} AOI(s) *)`);
  fbChunks.push("");
  const aoiGroups = groupRoutinesByAoi(extracted.stRoutines, extracted.ladderRoutines);
  for (const aoi of extracted.aois) {
    const group = aoiGroups.get(aoi.name);
    const bodies = new Map<string, string>();
    if (group) {
      for (const r of group.st) {
        const b = routineBodies.get(keyFor("AOI", aoi.name, r.name));
        if (b) bodies.set(r.name, b);
      }
      for (const r of group.ladder) {
        const b = routineBodies.get(keyFor("AOI", aoi.name, r.name));
        if (b) bodies.set(r.name, b);
      }
    }
    fbChunks.push(emitAoiAsFb(aoi, bodies));
    fbChunks.push("");
  }
  // ─── Coverage summary ──────────────────────────────────────────────
  diagnostics.unshift({
    severity: "INFO",
    code: "AB_MEL_L5K_002",
    message: `L5K extracted: ${stRoutinesOk}/${extracted.stRoutines.length} ST routines + ${ladderRoutinesOk}/${extracted.ladderRoutines.length} ladder routines translated (${ladderRungsTotal} rungs, ${ladderRungsFailed} rung parse failures) from controller "${extracted.controllerName ?? "<unknown>"}".`,
    line: 1,
  });
  if (manualPortSet.size > 0) {
    diagnostics.push({
      severity: "INFO",
      code: "AB_MEL_L5K_004",
      message: `Unsupported/manual-port instructions found: ${Array.from(manualPortSet).filter(s => s !== "st_manual_port").sort().join(", ")}`,
      line: 1,
    });
  }
  const output = outChunks.join("\n");
  const fbDefinitions = fbChunks.join("\n");
  const labelsCsv = emitLabelsCsv(extracted.tags, extracted.dataTypes);
  const mappingYaml = emitIoMapYaml(extracted.modules, extracted.ieVer, extracted.controllerName);
  const udtDefinitions = emitUdtSummary(extracted.dataTypes);
  const outputLines = output.split("\n").length;
  const warningCount = diagnostics.filter(d => d.severity === "WARN").length;
  const manualPortCount = diagnostics.filter(d => d.severity === "MANUAL_PORT").length + manualPortSet.size;
  const errorCount = diagnostics.filter(d => d.severity === "ERROR").length;
  return {
    ok: errorCount === 0,
    output,
    diagnostics,
    mappingYaml,
    labelsCsv,
    fbDefinitions,
    udtDefinitions,
    failureReport: errorCount > 0 ? {
      stage: "l5k_translate",
      error: `${errorCount} error(s) during L5K translation`,
      traceback: diagnostics.filter(d => d.severity === "ERROR").map(d => d.message).join("\n"),
      sourceContext: "",
      pipelineState: `${stRoutinesOk} ST routines OK, ${stRoutinesFailed} ST failed, ${ladderRoutinesOk} ladder routines OK`,
      timestamp,
      direction,
      inputLines,
    } : null,
    stats: {
      inputLines,
      outputLines,
      warningCount,
      manualPortCount,
      translatedNodes,
    },
  };
}
