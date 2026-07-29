/**
 * Built-in Mitsubishi language plugin (Phase 2).
 *
 *  - mitsubishi-gx-st: GX Works Structured Text (frontend + backend).
 *
 * The backend emits MEL ST from a Rockwell source (legacy ab2mel) via the
 * bridge; the IR emission path lands in Phases 3–5.
 */
import { parseSTSource } from "../parser";
import { looksLikeL5K } from "../l5k_extract";
import { IR_SCHEMA_VERSION } from "../version";
import { bridgeEmit } from "../compat/legacy-bridge";
import { mitsubishiTargetManifest } from "./rockwell";
import type {
  LanguageFrontend,
  LanguageBackend,
  SourceEmitCapable,
  DetectionResult,
  ParseResult,
  EmissionContext,
  EmissionResult,
  LoweringResult,
  CapabilityManifest,
  SourceArtifact,
  LanguageId,
} from "../contracts";

const ST_HINT = /(:=|\bEND_IF\b|\bEND_FOR\b|\bEND_WHILE\b|\bEND_CASE\b|\bVAR\b)/i;
/** Mitsubishi device addressing (D100, M200, X0, Y1F) — a MEL-leaning signal. */
const MEL_DEVICE_HINT = /\b[DMXYZTCR]\d{1,5}\b/;

export const mitsubishiGxStFrontend: LanguageFrontend = {
  id: "mitsubishi-gx-st",
  displayName: "Mitsubishi GX Works Structured Text",
  supportedArtifacts: ["structured_text"],
  detect(artifact: SourceArtifact): DetectionResult {
    if (looksLikeL5K(artifact.content)) {
      return { confidence: 0, evidence: ["input is an L5K project export, not MEL ST"] };
    }
    if (!ST_HINT.test(artifact.content)) {
      return { confidence: 0, evidence: ["no Structured Text markers found"] };
    }
    if (MEL_DEVICE_HINT.test(artifact.content)) {
      return { confidence: 0.7, evidence: ["Structured Text tokens present", "Mitsubishi device addressing (Dnnn/Mnnn/Xnn) present"] };
    }
    return { confidence: 0.5, evidence: ["Structured Text tokens present (dialect ambiguous vs Rockwell ST)"] };
  },
  parse(artifacts, _ctx): ParseResult {
    const src = artifacts.map((a) => a.content).join("\n");
    try {
      const ast = parseSTSource(src);
      return { ok: true, program: { irSchemaVersion: IR_SCHEMA_VERSION, sourceLanguage: "mitsubishi-gx-st", units: [], raw: ast }, diagnostics: [] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        program: null,
        diagnostics: [{ code: "PARSE_MITSUBISHI_ST", severity: "error", message, stage: "parse", language: "mitsubishi-gx-st", partial: true }],
      };
    }
  },
};

export const mitsubishiGxStBackend: LanguageBackend & SourceEmitCapable = {
  id: "mitsubishi-gx-st",
  displayName: "Mitsubishi GX Works Structured Text",
  supportedArtifacts: ["structured_text", "project_exchange"],
  capabilities(): CapabilityManifest {
    return mitsubishiTargetManifest();
  },
  lower(): LoweringResult {
    return {
      ok: false,
      program: null,
      diagnostics: [{ code: "LOWERING_IR_PATH_PENDING", severity: "info", message: "Canonical-IR lowering for mitsubishi-gx-st arrives in Phase 5; emission currently uses the legacy bridge.", stage: "lowering", language: "mitsubishi-gx-st", partial: true }],
      semanticLosses: [],
    };
  },
  emit(): EmissionResult {
    return {
      ok: false,
      artifacts: [],
      diagnostics: [{ code: "EMIT_IR_PATH_PENDING", severity: "info", message: "Canonical-IR emission for mitsubishi-gx-st arrives in Phase 5; emission currently uses the legacy bridge.", stage: "emit", language: "mitsubishi-gx-st", partial: true }],
      semanticLosses: [],
    };
  },
  legacyEmitSources: (): readonly LanguageId[] => ["rockwell-logix-st", "rockwell-l5k"],
  emitFromSource(sourceLanguage: LanguageId, source: string, ctx: EmissionContext) {
    const r = bridgeEmit(sourceLanguage, "mitsubishi-gx-st", source, "<input>", ctx.options);
    return { ok: r.ok, artifacts: r.artifacts, diagnostics: r.diagnostics, semanticLosses: [], stats: r.stats };
  },
};
