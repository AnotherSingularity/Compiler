/**
 * Legacy compatibility adapter (Phase 1).
 *
 * Bridges the proof-of-concept `translate(source, "ab2mel" | "mel2ab")` entry
 * point to the new language-neutral `CompileRequest` / `CompileResult` contract.
 *
 * IMPORTANT: this adapter delegates to the existing, unchanged `translate()` so
 * behavior stays byte-for-byte equivalent (Phase 1 gate). It does NOT re-route
 * through a registry yet — that is Phase 2. The only "compat logic" that may
 * hardcode `ab2mel`/`mel2ab` lives here, by design.
 */
import { translate, type TranslationResult, type Diagnostic as LegacyDiagnostic } from "../../translate";
import { looksLikeL5K } from "../l5k_extract";
import { COMPILER_VERSION, IR_SCHEMA_VERSION } from "../version";
import {
  type LanguageId,
  type SourceLanguageSelector,
  type CompileRequest,
  type CompileResult,
  type CompilerDiagnostic,
  type CompilerStage,
  type CompletenessLevel,
  type GeneratedArtifact,
  type SourceArtifact,
  isLanguageId,
  fromLegacySeverity,
  sortDiagnostics,
  lineSpan,
  hashValue,
  sha256Hex,
} from "../contracts";

export type LegacyDirection = "ab2mel" | "mel2ab";

export class CompileRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CompileRequestError";
    this.code = code;
  }
}

/** Map a legacy direction to explicit (source, target) languages. */
export function directionToLanguages(direction: LegacyDirection): {
  sourceLanguage: SourceLanguageSelector;
  targetLanguage: LanguageId;
} {
  if (direction === "ab2mel") {
    // Source is Rockwell (Logix ST or an L5K export) — resolved at compile time.
    return { sourceLanguage: "auto", targetLanguage: "mitsubishi-gx-st" };
  }
  return { sourceLanguage: "mitsubishi-gx-st", targetLanguage: "rockwell-logix-st" };
}

/** Build a CompileRequest from the legacy call shape. */
export function legacyRequest(
  source: string,
  direction: LegacyDirection,
  options?: { memoryMap?: string; labelsCsv?: string },
): CompileRequest {
  const { sourceLanguage, targetLanguage } = directionToLanguages(direction);
  return {
    sourceLanguage,
    targetLanguage,
    sourceArtifacts: [{ id: "<input>", content: source }],
    options,
  };
}

/**
 * Supported (source, target) emission combinations in Phase 1 — exactly the two
 * proof-of-concept routes. Everything else is a structured "unsupported
 * combination" result (fail closed).
 */
function resolveDirection(
  resolvedSource: LanguageId,
  target: LanguageId,
): LegacyDirection | null {
  if (
    (resolvedSource === "rockwell-logix-st" || resolvedSource === "rockwell-l5k") &&
    target === "mitsubishi-gx-st"
  ) {
    return "ab2mel";
  }
  if (resolvedSource === "mitsubishi-gx-st" && target === "rockwell-logix-st") {
    return "mel2ab";
  }
  return null;
}

/**
 * Resolve an "auto" source selector for the legacy routes. Real multi-language
 * detection is Phase 2; this mirrors the legacy behavior only.
 */
function resolveSourceLanguage(
  selector: SourceLanguageSelector,
  source: string,
  target: LanguageId,
): LanguageId {
  if (selector !== "auto") return selector;
  if (looksLikeL5K(source)) return "rockwell-l5k";
  // Legacy auto: the source is whatever pairs with the requested target.
  if (target === "mitsubishi-gx-st") return "rockwell-logix-st";
  if (target === "rockwell-logix-st") return "mitsubishi-gx-st";
  return "iec-61131-3-st";
}

function stageForCode(code: string): CompilerStage {
  if (/PARSE/.test(code)) return "parse";
  if (/L5K/.test(code)) return "project";
  if (/PIPELINE|EMIT/.test(code)) return "emit";
  return "emit";
}

function toCompilerDiagnostics(
  legacy: LegacyDiagnostic[],
  sourceId: string,
  sourceLang: LanguageId,
  targetLang: LanguageId,
): CompilerDiagnostic[] {
  const mapped: CompilerDiagnostic[] = legacy.map((d) => {
    const severity = fromLegacySeverity(d.severity);
    const diag: CompilerDiagnostic = {
      code: d.code,
      severity,
      message: d.message,
      stage: stageForCode(d.code),
      language: /MEL_AB/.test(d.code) ? targetLang : sourceLang,
      reviewRequired: severity === "manual_port" || severity === "error",
    };
    if (typeof d.line === "number" && d.line > 0) {
      diag.span = lineSpan(sourceId, d.line);
    }
    return diag;
  });
  return sortDiagnostics(mapped);
}

function buildArtifacts(result: TranslationResult, target: LanguageId): GeneratedArtifact[] {
  const artifacts: GeneratedArtifact[] = [];
  artifacts.push({ kind: "structured_text", language: target, name: "output.st", content: result.output });
  // Project-level interchange artifacts (present on the legacy result; include
  // the informative ones, skip empty optional blocks).
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

function completenessOf(result: TranslationResult, errorCount: number): CompletenessLevel {
  if (errorCount > 0 && (!result.output || result.output.trim() === "")) return "failed";
  if (result.stats.manualPortCount > 0 || errorCount > 0) return "review_required";
  if (result.stats.warningCount > 0) return "generated";
  return "executable_complete";
}

/**
 * Compile a request. Phase 1 supports only the two legacy routes; any other
 * combination fails closed with a structured diagnostic (no silent success).
 */
export function compile(request: CompileRequest): CompileResult {
  // ── Validation ────────────────────────────────────────────────────────
  if (request.sourceLanguage !== "auto" && !isLanguageId(request.sourceLanguage)) {
    throw new CompileRequestError("CAPABILITY_UNKNOWN_SOURCE_LANGUAGE", `Unknown source language: ${String(request.sourceLanguage)}`);
  }
  if (!isLanguageId(request.targetLanguage)) {
    throw new CompileRequestError("CAPABILITY_UNKNOWN_TARGET_LANGUAGE", `Unknown target language: ${String(request.targetLanguage)}`);
  }
  if (!Array.isArray(request.sourceArtifacts) || request.sourceArtifacts.length === 0) {
    throw new CompileRequestError("PROJECT_NO_SOURCE_ARTIFACTS", "CompileRequest requires at least one source artifact");
  }
  const emptyish = request.sourceArtifacts.every((a) => !a.content || a.content.trim() === "");
  if (emptyish) {
    throw new CompileRequestError("PROJECT_EMPTY_SOURCE", "All source artifacts are empty");
  }

  const source = concatArtifacts(request.sourceArtifacts);
  const sourceId = request.sourceArtifacts[0].id ?? "<input>";
  const resolvedSource = resolveSourceLanguage(request.sourceLanguage, source, request.targetLanguage);
  const direction = resolveDirection(resolvedSource, request.targetLanguage);

  if (!direction) {
    // Fail closed — unsupported combination is not an exception, it's a result.
    const diagnostics: CompilerDiagnostic[] = [
      {
        code: "CAPABILITY_UNSUPPORTED_COMBINATION",
        severity: "error",
        message: `No backend can emit ${request.targetLanguage} from ${resolvedSource} yet.`,
        stage: "capability",
        language: request.targetLanguage,
        reviewRequired: true,
        partial: false,
        suggestedAction: "Choose a supported source/target pair (Rockwell↔Mitsubishi ST) or wait for backend support.",
      },
    ];
    return {
      ok: false,
      completeness: "failed",
      compilerVersion: COMPILER_VERSION,
      irSchemaVersion: IR_SCHEMA_VERSION,
      sourceLanguage: resolvedSource,
      targetLanguage: request.targetLanguage,
      artifacts: [],
      diagnostics,
      semanticLosses: [],
      stats: {
        inputLines: source.split("\n").length,
        outputLines: 0,
        warningCount: 0,
        manualPortCount: 0,
        errorCount: 1,
        translatedNodes: 0,
      },
      hashes: {
        source: sha256Hex(source),
        artifacts: hashValue([]),
        diagnostics: hashValue(diagnostics),
      },
    };
  }

  // ── Delegate to the protected legacy pipeline (behavior-equivalent) ──────
  const legacy = translate(source, direction, request.options);
  const errorCount = legacy.diagnostics.filter((d) => d.severity === "ERROR").length;
  const diagnostics = toCompilerDiagnostics(legacy.diagnostics, sourceId, resolvedSource, request.targetLanguage);
  const artifacts = buildArtifacts(legacy, request.targetLanguage);

  return {
    // Behaviorally equivalent to legacy `ok`; `completeness` carries the finer
    // honesty signal until Phase 6 tightens `ok`.
    ok: legacy.ok,
    completeness: completenessOf(legacy, errorCount),
    compilerVersion: COMPILER_VERSION,
    irSchemaVersion: IR_SCHEMA_VERSION,
    sourceLanguage: resolvedSource,
    targetLanguage: request.targetLanguage,
    artifacts,
    diagnostics,
    semanticLosses: [],
    stats: {
      inputLines: legacy.stats.inputLines,
      outputLines: legacy.stats.outputLines,
      warningCount: legacy.stats.warningCount,
      manualPortCount: legacy.stats.manualPortCount,
      errorCount,
      translatedNodes: legacy.stats.translatedNodes,
    },
    hashes: {
      source: sha256Hex(source),
      artifacts: hashValue(artifacts),
      diagnostics: hashValue(diagnostics),
    },
  };
}

/** Legacy convenience: `compileLegacy(source, "ab2mel")` — direction → request → compile. */
export function compileLegacy(
  source: string,
  direction: LegacyDirection,
  options?: { memoryMap?: string; labelsCsv?: string },
): CompileResult {
  return compile(legacyRequest(source, direction, options));
}

function concatArtifacts(artifacts: SourceArtifact[]): string {
  return artifacts.map((a) => a.content).join("\n");
}
