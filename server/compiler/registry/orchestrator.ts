/**
 * Registry-driven compile orchestrator (Phase 2).
 *
 * This is the "central orchestrator". It contains NO `ab2mel`/`mel2ab` if/else
 * (Phase 2 gate) — routing is driven by the registry: detect/resolve the source
 * language, look up the target backend, consult its capability + emit surface,
 * and fail closed when no route exists. Legacy direction strings live only in
 * the bridge/backends (compat layer).
 */
import {
  COMPILER_VERSION,
  IR_SCHEMA_VERSION,
  isSourceEmitCapable,
  hashValue,
  sha256Hex,
  type CompileRequest,
  type CompileResult,
  type CompilerDiagnostic,
  type CompletenessLevel,
  type LanguageId,
  type GeneratedArtifact,
} from "../contracts";
import type { LanguageRegistry } from "./registry";
import { tryCanonicalCompile } from "../migration/routing";

function fail(
  request: CompileRequest,
  resolvedSource: LanguageId | null,
  source: string,
  diagnostics: CompilerDiagnostic[],
): CompileResult {
  return {
    ok: false,
    completeness: "failed",
    compilerVersion: COMPILER_VERSION,
    irSchemaVersion: IR_SCHEMA_VERSION,
    sourceLanguage: resolvedSource ?? "iec-61131-3-st",
    targetLanguage: request.targetLanguage,
    artifacts: [],
    diagnostics,
    semanticLosses: [],
    stats: { inputLines: source.split("\n").length, outputLines: 0, warningCount: 0, manualPortCount: 0, errorCount: diagnostics.filter((d) => d.severity === "error").length, translatedNodes: 0 },
    hashes: { source: sha256Hex(source), artifacts: hashValue([] as GeneratedArtifact[]), diagnostics: hashValue(diagnostics) },
  };
}

function completenessOf(stats: { manualPortCount: number; warningCount: number; errorCount: number }, outputEmpty: boolean): CompletenessLevel {
  if (stats.errorCount > 0 && outputEmpty) return "failed";
  if (stats.manualPortCount > 0 || stats.errorCount > 0) return "review_required";
  if (stats.warningCount > 0) return "generated";
  return "executable_complete";
}

export function compileWithRegistry(request: CompileRequest, registry: LanguageRegistry): CompileResult {
  const source = request.sourceArtifacts.map((a) => a.content).join("\n");
  const firstArtifact = request.sourceArtifacts[0];

  // ── Resolve source language (explicit, or detect via the registry) ──────
  let resolvedSource: LanguageId;
  if (request.sourceLanguage === "auto") {
    const outcome = registry.detect(firstArtifact);
    if (!outcome.language) {
      const evidence = outcome.candidates.map((c) => `${c.language} (${c.confidence.toFixed(2)}): ${c.evidence.join("; ")}`);
      return fail(request, null, source, [
        {
          code: outcome.reason === "ambiguous" ? "DETECTION_AMBIGUOUS" : "DETECTION_NO_MATCH",
          severity: "error",
          message:
            outcome.reason === "ambiguous"
              ? `Source language is ambiguous between: ${outcome.candidates.slice(0, 2).map((c) => c.language).join(", ")}. Specify sourceLanguage explicitly.`
              : "No registered frontend recognized this source. Specify sourceLanguage explicitly.",
          stage: "detection",
          reviewRequired: true,
          suggestedAction: "Pass an explicit sourceLanguage instead of 'auto'.",
          relatedEntity: evidence.join(" | ") || undefined,
        },
      ]);
    }
    resolvedSource = outcome.language;
  } else {
    resolvedSource = request.sourceLanguage;
  }

  // ── Look up the target backend ──────────────────────────────────────────
  const backend = registry.getBackend(request.targetLanguage);
  if (!backend) {
    // No backend for the target → the source/target route is unsupported.
    return fail(request, resolvedSource, source, [
      { code: "CAPABILITY_UNSUPPORTED_COMBINATION", severity: "error", message: `No backend registered for target language ${request.targetLanguage}; route ${resolvedSource} → ${request.targetLanguage} is unsupported.`, stage: "capability", language: request.targetLanguage, reviewRequired: true, suggestedAction: "Choose a target with a registered backend." },
    ]);
  }

  // ── Can this backend emit from the resolved source? (fail closed) ───────
  const canEmit = isSourceEmitCapable(backend) && backend.legacyEmitSources().includes(resolvedSource);
  if (!canEmit) {
    return fail(request, resolvedSource, source, [
      {
        code: "CAPABILITY_UNSUPPORTED_COMBINATION",
        severity: "error",
        message: `Backend ${backend.id} cannot emit from ${resolvedSource} yet.`,
        stage: "capability",
        language: request.targetLanguage,
        reviewRequired: true,
        suggestedAction: "Choose a supported source/target pair (Rockwell↔Mitsubishi ST).",
      },
    ]);
  }

  // ── Canonical pipeline (active migration families) ──────────────────────
  // If the whole program is covered by canonical-active families, emit via the
  // canonical lowering/emission path. Otherwise fall through to the legacy
  // engine (which still owns unmigrated families). This is the incremental
  // production migration: canonical for what's activated, legacy for the rest.
  const canonical = tryCanonicalCompile(source, resolvedSource, request.targetLanguage);
  if (canonical) {
    return {
      ok: true,
      completeness: "executable_complete",
      compilerVersion: COMPILER_VERSION,
      irSchemaVersion: IR_SCHEMA_VERSION,
      sourceLanguage: resolvedSource,
      targetLanguage: request.targetLanguage,
      artifacts: canonical.artifacts,
      diagnostics: canonical.diagnostics,
      semanticLosses: [],
      stats: {
        inputLines: source.split("\n").length,
        outputLines: canonical.outputLines,
        warningCount: 0,
        manualPortCount: 0,
        errorCount: 0,
        translatedNodes: canonical.translatedNodes,
      },
      hashes: { source: sha256Hex(source), artifacts: hashValue(canonical.artifacts), diagnostics: hashValue(canonical.diagnostics) },
      migration: canonical.summary,
    };
  }

  // ── Emit (transitional legacy bridge — unmigrated families) ─────────────
  const emit = backend.emitFromSource(resolvedSource, source, { options: request.options });
  const outputArtifact = emit.artifacts.find((a) => a.name === "output.st");
  const outputEmpty = !outputArtifact || outputArtifact.content.trim() === "";

  return {
    ok: emit.ok,
    completeness: completenessOf(emit.stats, outputEmpty),
    compilerVersion: COMPILER_VERSION,
    irSchemaVersion: IR_SCHEMA_VERSION,
    sourceLanguage: resolvedSource,
    targetLanguage: request.targetLanguage,
    artifacts: emit.artifacts,
    diagnostics: emit.diagnostics,
    semanticLosses: emit.semanticLosses,
    stats: {
      inputLines: emit.stats.inputLines,
      outputLines: emit.stats.outputLines,
      warningCount: emit.stats.warningCount,
      manualPortCount: emit.stats.manualPortCount,
      errorCount: emit.stats.errorCount,
      translatedNodes: emit.stats.translatedNodes,
    },
    hashes: { source: sha256Hex(source), artifacts: hashValue(emit.artifacts), diagnostics: hashValue(emit.diagnostics) },
    migration: {
      familyStatuses: {},
      canonicalNodeCount: 0,
      legacyNodeCount: emit.stats.translatedNodes,
      fallbackCount: 0,
      shadowComparisonCount: 0,
      approvedDifferenceCount: 0,
      unapprovedDifferenceCount: 0,
      engine: "legacy",
    },
  };
}
