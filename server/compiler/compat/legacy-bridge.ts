/**
 * Legacy emission bridge (Phase 2→5 transition).
 *
 * The SINGLE place, besides the direction adapter, where the `ab2mel`/`mel2ab`
 * strings live. Built-in backends call this to emit output via the protected
 * legacy `translate()` while the canonical-IR emission path is built out
 * (Phases 3–5). The registry orchestrator does NOT reference legacy directions
 * — it only asks a backend to emit from a source language, and the backend
 * routes here.
 */
import { translate, type Diagnostic as LegacyDiagnostic } from "../../translate";
import {
  type LanguageId,
  type CompilerDiagnostic,
  type CompilerStage,
  type GeneratedArtifact,
  fromLegacySeverity,
  sortDiagnostics,
  lineSpan,
} from "../contracts";

export interface LegacyBridgeResult {
  ok: boolean;
  artifacts: GeneratedArtifact[];
  diagnostics: CompilerDiagnostic[];
  stats: {
    inputLines: number;
    outputLines: number;
    warningCount: number;
    manualPortCount: number;
    errorCount: number;
    translatedNodes: number;
  };
}

/** Map a (source, target) language pair to a legacy direction, if one exists. */
export function legacyDirectionFor(
  sourceLanguage: LanguageId,
  targetLanguage: LanguageId,
): "ab2mel" | "mel2ab" | null {
  if (
    (sourceLanguage === "rockwell-logix-st" || sourceLanguage === "rockwell-l5k") &&
    targetLanguage === "mitsubishi-gx-st"
  ) {
    return "ab2mel";
  }
  if (sourceLanguage === "mitsubishi-gx-st" && targetLanguage === "rockwell-logix-st") {
    return "mel2ab";
  }
  return null;
}

function stageForCode(code: string): CompilerStage {
  if (/PARSE/.test(code)) return "parse";
  if (/L5K/.test(code)) return "project";
  return "emit";
}

function mapDiagnostics(
  legacy: LegacyDiagnostic[],
  sourceId: string,
  sourceLang: LanguageId,
  targetLang: LanguageId,
): CompilerDiagnostic[] {
  return sortDiagnostics(
    legacy.map((d) => {
      const severity = fromLegacySeverity(d.severity);
      const diag: CompilerDiagnostic = {
        code: d.code,
        severity,
        message: d.message,
        stage: stageForCode(d.code),
        language: /MEL_AB/.test(d.code) ? targetLang : sourceLang,
        reviewRequired: severity === "manual_port" || severity === "error",
      };
      if (typeof d.line === "number" && d.line > 0) diag.span = lineSpan(sourceId, d.line);
      return diag;
    }),
  );
}

function buildArtifacts(
  result: ReturnType<typeof translate>,
  target: LanguageId,
): GeneratedArtifact[] {
  const artifacts: GeneratedArtifact[] = [
    { kind: "structured_text", language: target, name: "output.st", content: result.output },
  ];
  if (result.mappingYaml && result.mappingYaml.trim() && result.mappingYaml !== "allocations: {}\n") {
    artifacts.push({ kind: "project_exchange", language: target, name: "mapping.yaml", content: result.mappingYaml });
  }
  if (result.labelsCsv && result.labelsCsv.split(/\r?\n/).length > 1) {
    artifacts.push({ kind: "project_exchange", language: target, name: "labels.csv", content: result.labelsCsv });
  }
  const fb = (result as { fbDefinitions?: string }).fbDefinitions;
  if (fb && fb.trim()) {
    artifacts.push({ kind: "structured_text", language: target, name: "fb_definitions.st", content: fb });
  }
  const udt = (result as { udtDefinitions?: string }).udtDefinitions;
  if (udt && udt.trim()) {
    artifacts.push({ kind: "project_exchange", language: target, name: "udt_definitions.txt", content: udt });
  }
  return artifacts;
}

/**
 * Emit target output from a source artifact via the legacy pipeline.
 * Throws if the (source, target) pair has no legacy direction — callers must
 * check the backend capability first (fail closed at the orchestrator).
 */
export function bridgeEmit(
  sourceLanguage: LanguageId,
  targetLanguage: LanguageId,
  source: string,
  sourceId: string,
  options?: { memoryMap?: string; labelsCsv?: string },
): LegacyBridgeResult {
  const direction = legacyDirectionFor(sourceLanguage, targetLanguage);
  if (!direction) {
    throw new Error(`legacy bridge has no route ${sourceLanguage} → ${targetLanguage}`);
  }
  const legacy = translate(source, direction, options);
  const errorCount = legacy.diagnostics.filter((d) => d.severity === "ERROR").length;
  return {
    ok: legacy.ok,
    artifacts: buildArtifacts(legacy, targetLanguage),
    diagnostics: mapDiagnostics(legacy.diagnostics, sourceId, sourceLanguage, targetLanguage),
    stats: {
      inputLines: legacy.stats.inputLines,
      outputLines: legacy.stats.outputLines,
      warningCount: legacy.stats.warningCount,
      manualPortCount: legacy.stats.manualPortCount,
      errorCount,
      translatedNodes: legacy.stats.translatedNodes,
    },
  };
}
