/**
 * Language plugin contracts — frontend + backend (Phase 2).
 *
 * A frontend parses vendor syntax into a source model that can be normalized to
 * canonical IR. A backend consumes canonical (or target-lowered) IR and emits
 * artifacts. A backend must NOT depend on another vendor's source AST
 * (invariant A). The IR-based `lower`/`emit` methods are the target
 * architecture; during migration (Phases 2→5) the orchestrator may route
 * supported legacy pairs through a transitional bridge instead — see
 * `SourceEmitCapable`.
 */
import type { LanguageId, ArtifactKind } from "./ids";
import type { SourceArtifact } from "./source";
import type { CompilerDiagnostic } from "./diagnostics";
import type { CapabilityManifest } from "./capability";
import type { CanonicalProgram, LoweredProgram } from "./ir";
import type { GeneratedArtifact, CompileOptions, SemanticLossRecord } from "./compile";

export interface DetectionResult {
  /** Confidence in [0,1] that this frontend should handle the artifact. */
  confidence: number;
  /** Human-readable evidence for the score (deterministic, ordered). */
  evidence: string[];
}

export interface FrontendContext {
  options?: CompileOptions;
}

export interface ParseResult {
  ok: boolean;
  /** Canonical program (Phase 3+). In Phase 2, `raw` carries the legacy AST. */
  program: CanonicalProgram | null;
  diagnostics: CompilerDiagnostic[];
}

export interface LanguageFrontend {
  readonly id: LanguageId;
  readonly displayName: string;
  readonly supportedArtifacts: readonly ArtifactKind[];
  detect(artifact: SourceArtifact): DetectionResult;
  parse(artifacts: readonly SourceArtifact[], context: FrontendContext): ParseResult;
}

export interface LoweringContext {
  target: LanguageId;
  options?: CompileOptions;
}

export interface LoweringResult {
  ok: boolean;
  program: LoweredProgram | null;
  diagnostics: CompilerDiagnostic[];
  semanticLosses: SemanticLossRecord[];
}

export interface EmissionContext {
  options?: CompileOptions;
}

export interface EmissionResult {
  ok: boolean;
  artifacts: GeneratedArtifact[];
  diagnostics: CompilerDiagnostic[];
  semanticLosses: SemanticLossRecord[];
}

export interface LanguageBackend {
  readonly id: LanguageId;
  readonly displayName: string;
  readonly supportedArtifacts: readonly ArtifactKind[];
  capabilities(): CapabilityManifest;
  /** Target-lowering pass (canonical IR → target-lowered IR). Phase 3+/5. */
  lower(program: CanonicalProgram, context: LoweringContext): LoweringResult;
  /** Emit artifacts from a lowered program. Phase 3+/5. */
  emit(program: LoweredProgram, context: EmissionContext): EmissionResult;
}

/**
 * Transitional capability implemented by built-in backends during the
 * Phase 2→5 migration: emit directly from a source artifact for a
 * registry-declared source language, delegating to the protected legacy
 * pipeline. This is how the orchestrator produces output without an
 * `ab2mel`/`mel2ab` if/else while the IR path is still being built. The legacy
 * direction strings live only inside the implementation (compat layer).
 */
export interface SourceEmitCapable {
  /** Source languages this backend can currently emit from via the bridge. */
  legacyEmitSources(): readonly LanguageId[];
  emitFromSource(
    sourceLanguage: LanguageId,
    source: string,
    context: EmissionContext,
  ): EmissionResult & {
    stats: {
      inputLines: number;
      outputLines: number;
      warningCount: number;
      manualPortCount: number;
      errorCount: number;
      translatedNodes: number;
    };
    ok: boolean;
  };
}

export function isSourceEmitCapable(b: LanguageBackend): b is LanguageBackend & SourceEmitCapable {
  return typeof (b as Partial<SourceEmitCapable>).emitFromSource === "function";
}
