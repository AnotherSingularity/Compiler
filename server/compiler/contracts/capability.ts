/**
 * Capability manifest contracts (Phase 2 shape; enforced/expanded in Phase 6).
 *
 * A backend declares, machine-readably, what it can and cannot do. The
 * orchestrator consults this before routing — unsupported routes fail closed
 * (invariant D) rather than emitting approximate output.
 */
import type { LanguageId, TranslationDisposition } from "./ids";
import type {
  SemanticOperationKind,
  CanonicalTypeKind,
  ProjectFeatureKind,
} from "./operations";

/** Coarse support signal; the disposition on a rule carries the nuance. */
export type SupportLevel = "supported" | "conditional" | "manual" | "unsupported";

export interface CapabilityRule {
  level: SupportLevel;
  /** Disposition a translation using this capability will carry by default. */
  disposition: TranslationDisposition;
  /** Preconditions that must hold for `supported`/`conditional` to apply. */
  preconditions?: string[];
  /** Known semantic differences vs the source behavior. */
  differences?: string[];
  /** Target options required to enable this capability. */
  requiredOptions?: string[];
  /** True if generated output requires manual completion by an engineer. */
  requiresManualCompletion?: boolean;
  /** Diagnostic code emitted when this rule downgrades a translation. */
  diagnosticCode?: string;
  /** Doc anchor (e.g. "CAPABILITY_MODEL.md#ton"). */
  docRef?: string;
}

export interface CapabilityManifest {
  language: LanguageId;
  version: string;
  operations: Partial<Record<SemanticOperationKind, CapabilityRule>>;
  types: Partial<Record<CanonicalTypeKind, CapabilityRule>>;
  projectFeatures: Partial<Record<ProjectFeatureKind, CapabilityRule>>;
}

/** Convenience: is a semantic op emittable (not `unsupported`) by this manifest? */
export function operationSupport(
  manifest: CapabilityManifest,
  op: SemanticOperationKind,
): CapabilityRule {
  return (
    manifest.operations[op] ?? {
      level: "unsupported",
      disposition: "unsupported",
      diagnosticCode: "CAPABILITY_OPERATION_UNDECLARED",
    }
  );
}
