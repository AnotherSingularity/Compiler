/**
 * Compiler diagnostic contract.
 *
 * Every diagnostic carries a stable code, severity, message, optional span,
 * language, stage, related entity, suggested action, and the partial/review
 * flags (per the mandate's Diagnostic Requirements). Ordering is made
 * deterministic by `compareDiagnostics`.
 */
import type { LanguageId, CompilerStage } from "./ids";
import type { SourceSpan } from "./source";

export type DiagnosticSeverity = "info" | "warning" | "manual_port" | "error";

export interface CompilerDiagnostic {
  /** Stable namespaced code, e.g. "CAPABILITY_UNSUPPORTED_TARGET". */
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  /** Provenance when applicable. */
  span?: SourceSpan;
  /** Language the diagnostic pertains to (source or target). */
  language?: LanguageId;
  /** Pipeline stage that produced it. */
  stage: CompilerStage;
  /** Related canonical node id or project entity (routine/tag/module) id. */
  relatedEntity?: string;
  /** Actionable hint for the engineer, when useful. */
  suggestedAction?: string;
  /** True if compilation continued in a degraded/partial way past this point. */
  partial?: boolean;
  /** True if an engineer must review before the output can be trusted. */
  reviewRequired?: boolean;
}

/** Legacy severity spellings used by the proof-of-concept `Diagnostic`. */
export type LegacySeverity = "INFO" | "WARN" | "MANUAL_PORT" | "ERROR";

const LEGACY_SEVERITY_MAP: Record<LegacySeverity, DiagnosticSeverity> = {
  INFO: "info",
  WARN: "warning",
  MANUAL_PORT: "manual_port",
  ERROR: "error",
};

export function fromLegacySeverity(s: LegacySeverity | string): DiagnosticSeverity {
  return LEGACY_SEVERITY_MAP[s as LegacySeverity] ?? "info";
}

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  error: 0,
  manual_port: 1,
  warning: 2,
  info: 3,
};

/**
 * Deterministic total order for diagnostics (invariant E). Primary: severity
 * (error first). Secondary: stage. Tertiary: span line. Then code, then message.
 * Pure and stable — no timestamps or object identity involved.
 */
export function compareDiagnostics(a: CompilerDiagnostic, b: CompilerDiagnostic): number {
  const sr = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (sr !== 0) return sr;
  const st = (a.stage ?? "").localeCompare(b.stage ?? "");
  if (st !== 0) return st;
  const la = a.span?.start.line ?? Number.MAX_SAFE_INTEGER;
  const lb = b.span?.start.line ?? Number.MAX_SAFE_INTEGER;
  if (la !== lb) return la - lb;
  const cc = a.code.localeCompare(b.code);
  if (cc !== 0) return cc;
  return a.message.localeCompare(b.message);
}

export function sortDiagnostics(diags: readonly CompilerDiagnostic[]): CompilerDiagnostic[] {
  return [...diags].sort(compareDiagnostics);
}
