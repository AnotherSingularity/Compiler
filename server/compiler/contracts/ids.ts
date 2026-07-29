/**
 * Compiler identity contracts — language ids, artifact kinds, translation
 * dispositions, and compiler stages.
 *
 * These are language-neutral. Vendor instruction spellings (TON, COP, BMOV,
 * ...) must NOT appear here — they belong to frontend/backend mappings
 * (invariant C). This module is pure types + small const tables with no
 * runtime side effects.
 */

/** Languages the platform knows about (support level varies — see the registry). */
export type LanguageId =
  | "rockwell-logix-st"
  | "rockwell-l5k"
  | "mitsubishi-gx-st"
  | "iec-61131-3-st"
  | "siemens-scl"
  | "codesys-st"
  | "aeon";

export const ALL_LANGUAGE_IDS: readonly LanguageId[] = [
  "rockwell-logix-st",
  "rockwell-l5k",
  "mitsubishi-gx-st",
  "iec-61131-3-st",
  "siemens-scl",
  "codesys-st",
  "aeon",
] as const;

export function isLanguageId(v: unknown): v is LanguageId {
  return typeof v === "string" && (ALL_LANGUAGE_IDS as readonly string[]).includes(v);
}

/** A source language selector may be an explicit id or automatic detection. */
export type SourceLanguageSelector = LanguageId | "auto";

/** Kinds of artifact the compiler consumes or produces. */
export type ArtifactKind =
  | "structured_text"
  | "project_exchange"
  | "ladder"
  | "canonical_ir"
  | "runtime_manifest";

export const ALL_ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "structured_text",
  "project_exchange",
  "ladder",
  "canonical_ir",
  "runtime_manifest",
] as const;

/**
 * Disposition of a single operation's translation (invariant D — fail closed).
 * No `unsupported` operation may silently pass through as valid target code.
 */
export type TranslationDisposition =
  | "exact"
  | "equivalent_lowering"
  | "synthesized"
  | "lossy"
  | "manual_port"
  | "unsupported";

export const ALL_DISPOSITIONS: readonly TranslationDisposition[] = [
  "exact",
  "equivalent_lowering",
  "synthesized",
  "lossy",
  "manual_port",
  "unsupported",
] as const;

/** Compiler pipeline stage a diagnostic or result originates from. */
export type CompilerStage =
  | "detection"
  | "parse"
  | "semantic"
  | "ir"
  | "capability"
  | "lowering"
  | "emit"
  | "project"
  | "manifest"
  | "adapter";

/**
 * Levels of "success". `ok` (executable-complete) is the strictest; the others
 * let the UI and callers distinguish partial results honestly (invariant D /
 * Phase 6). Ordered from weakest to strongest.
 */
export type CompletenessLevel =
  | "failed"
  | "parsed"
  | "analyzed"
  | "generated"
  | "review_required"
  | "executable_complete";
