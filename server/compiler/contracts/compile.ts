/**
 * Top-level compile request/result contracts.
 *
 * This is the language-neutral public shape the platform is migrating toward.
 * The legacy `translate(source, direction)` entry point is preserved and mapped
 * onto `CompileRequest` by the compatibility adapter (Phase 1). The UI/API move
 * to this shape in Phase 11.
 */
import type {
  LanguageId,
  SourceLanguageSelector,
  ArtifactKind,
  TranslationDisposition,
  CompletenessLevel,
} from "./ids";
import type { SourceArtifact, SourceSpan } from "./source";
import type { CompilerDiagnostic } from "./diagnostics";

export interface CompileOptions {
  /** User-supplied memory-map overrides (legacy `options.memoryMap`). */
  memoryMap?: string;
  /** User-supplied labels CSV seed (legacy `options.labelsCsv`). */
  labelsCsv?: string;
  /** Dialect/profile hint for frontends that need it (e.g. codesys vs iec). */
  dialect?: string;
  /** When true, callers accept partial/review-required output. Default true. */
  allowPartial?: boolean;
}

export interface CompileRequest {
  sourceLanguage: SourceLanguageSelector;
  targetLanguage: LanguageId;
  sourceArtifacts: SourceArtifact[];
  options?: CompileOptions;
}

export interface GeneratedArtifact {
  kind: ArtifactKind;
  /** Backend language that produced it. */
  language: LanguageId;
  /** File-like name, e.g. "output.st", "mapping.yaml", "labels.csv". */
  name: string;
  content: string;
  /** Originating project entity (routine/program/AOI/module), when known. */
  originEntity?: string;
}

/**
 * Authoritative, structured record of a semantic loss (invariant D / Phase 6).
 * Generated comments are supplemental; this record is the source of truth.
 */
export interface SemanticLossRecord {
  id: string;
  nodeId: string;
  span?: SourceSpan;
  sourceLanguage: LanguageId;
  targetLanguage: LanguageId;
  category: string;
  disposition: TranslationDisposition;
  description: string;
  sourceSemantics: string[];
  targetSemantics: string[];
  requiredAction?: string;
}

export interface CompileStats {
  inputLines: number;
  outputLines: number;
  warningCount: number;
  manualPortCount: number;
  errorCount: number;
  /** Count of successfully translated canonical operations/nodes. */
  translatedNodes: number;
  /** Per-disposition tallies (populated as the IR/capability layers land). */
  dispositions?: Partial<Record<TranslationDisposition, number>>;
}

/**
 * Which engine produced the output and how the incremental migration routed the
 * program, family by family. Present while the legacy engine and canonical
 * pipeline coexist (transitional). `engine: "canonical"` means the output was
 * produced by the canonical lowering/emission path, not the legacy translator.
 */
export interface MigrationExecutionSummary {
  familyStatuses: Record<string, string>;
  canonicalNodeCount: number;
  legacyNodeCount: number;
  fallbackCount: number;
  shadowComparisonCount: number;
  approvedDifferenceCount: number;
  unapprovedDifferenceCount: number;
  /** "mixed" = some statements canonical, some legacy, in one program. */
  engine: "canonical" | "legacy" | "mixed";
}

export interface CompileHashes {
  /** sha256 over concatenated source artifact bytes. */
  source: string;
  /** sha256 over the generated artifacts (deterministic, order-stable). */
  artifacts: string;
  /** sha256 over the (timestamp-free) diagnostics. */
  diagnostics: string;
  /** sha256 over the canonical IR, once the IR path is active (Phase 3+). */
  ir?: string;
}

export interface CompileResult {
  ok: boolean;
  /** Finer-grained honesty signal than `ok` (invariant D / Phase 6). */
  completeness: CompletenessLevel;
  compilerVersion: string;
  irSchemaVersion: string;
  /** Resolved source language (detection may have chosen it). */
  sourceLanguage: LanguageId;
  targetLanguage: LanguageId;
  artifacts: GeneratedArtifact[];
  diagnostics: CompilerDiagnostic[];
  semanticLosses: SemanticLossRecord[];
  stats: CompileStats;
  hashes: CompileHashes;
  /** Transitional migration routing summary (canonical vs legacy). */
  migration?: MigrationExecutionSummary;
}
