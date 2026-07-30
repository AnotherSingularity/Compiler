/**
 * Built-in Rockwell language plugins (Phase 2).
 *
 *  - rockwell-logix-st: Studio 5000 Logix Structured Text (frontend + backend).
 *  - rockwell-l5k:      Studio 5000 L5K project export (frontend; project body
 *                       routines delegate to the Logix ST frontend — invariant A).
 *
 * Emission is routed through the protected legacy pipeline via the bridge
 * (SourceEmitCapable) until the canonical-IR path lands (Phases 3–5).
 */
import { parseSTSource } from "../parser";
import { extractL5K, looksLikeL5K } from "../l5k_extract";
import { IR_SCHEMA_VERSION } from "../version";
import { bridgeEmit } from "../compat/legacy-bridge";
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
  CanonicalProgram,
} from "../contracts";

const ST_HINT = /(:=|\bEND_IF\b|\bEND_FOR\b|\bEND_WHILE\b|\bEND_CASE\b|\bVAR\b)/i;

function stProgram(sourceLanguage: LanguageId, ast: unknown): CanonicalProgram {
  return { irSchemaVersion: IR_SCHEMA_VERSION, sourceLanguage, units: [], raw: ast };
}

// ── rockwell-logix-st ─────────────────────────────────────────────────────

export const rockwellLogixStFrontend: LanguageFrontend = {
  id: "rockwell-logix-st",
  displayName: "Rockwell Logix Structured Text",
  supportedArtifacts: ["structured_text"],
  detect(artifact: SourceArtifact): DetectionResult {
    if (looksLikeL5K(artifact.content)) {
      return { confidence: 0, evidence: ["input is an L5K project export, not bare ST"] };
    }
    if (ST_HINT.test(artifact.content)) {
      return { confidence: 0.5, evidence: ["Structured Text tokens present (:= / END_* / VAR)"] };
    }
    return { confidence: 0, evidence: ["no Structured Text markers found"] };
  },
  parse(artifacts, _ctx): ParseResult {
    const src = artifacts.map((a) => a.content).join("\n");
    try {
      const ast = parseSTSource(src);
      return { ok: true, program: stProgram("rockwell-logix-st", ast), diagnostics: [] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        program: null,
        diagnostics: [{ code: "PARSE_ROCKWELL_ST", severity: "error", message, stage: "parse", language: "rockwell-logix-st", partial: true }],
      };
    }
  },
};

function mitsubishiTargetManifest(): CapabilityManifest {
  // Manifest describing what emitting MEL ST FROM a Rockwell source preserves.
  return {
    language: "mitsubishi-gx-st",
    version: "0.1.0",
    operations: {
      Assignment: { level: "supported", disposition: "exact" },
      ConditionalBranch: { level: "supported", disposition: "exact" },
      CaseSelection: { level: "supported", disposition: "exact" },
      ForLoop: { level: "supported", disposition: "exact" },
      WhileLoop: { level: "supported", disposition: "exact" },
      RepeatUntil: { level: "supported", disposition: "exact" },
      FunctionCall: { level: "supported", disposition: "equivalent_lowering" },
      FunctionBlockInvoke: { level: "supported", disposition: "equivalent_lowering" },
      ProgramCall: { level: "supported", disposition: "exact", differences: ["JSR → routine invocation"] },
      TimerOnDelay: { level: "conditional", disposition: "lossy", differences: ["IN enable and PT preset not lexically derivable; emitted with placeholders requiring manual completion"], requiresManualCompletion: true, diagnosticCode: "AB_MEL_TIMER_001" },
      TimerOffDelay: { level: "conditional", disposition: "lossy", differences: ["IN enable and PT preset not lexically derivable; emitted with placeholders requiring manual completion"], requiresManualCompletion: true, diagnosticCode: "AB_MEL_TIMER_001" },
      TimerRetentive: { level: "conditional", disposition: "lossy", differences: ["reset path must be wired manually"], requiresManualCompletion: true, diagnosticCode: "AB_MEL_TIMER_002" },
      CounterUp: { level: "conditional", disposition: "lossy", requiresManualCompletion: true },
      CounterDown: { level: "conditional", disposition: "lossy", requiresManualCompletion: true },
      BlockCopy: { level: "conditional", disposition: "equivalent_lowering", differences: ["confirm MEL block-move primitive"] },
      SynchronousBlockCopy: { level: "conditional", disposition: "equivalent_lowering", differences: ["CPS synchronous copy → MEL block-move; confirm atomicity semantics"] },
      MaskedMove: { level: "conditional", disposition: "equivalent_lowering", differences: ["MVM masked move → MEL AND/OR mask sequence; confirm mask semantics"] },
      PIDControl: { level: "manual", disposition: "manual_port", requiresManualCompletion: true, diagnosticCode: "AB_MEL_PID_001" },
      MotionCommand: { level: "unsupported", disposition: "unsupported", diagnosticCode: "AB_MEL_MOTION_001" },
      MessageTransfer: { level: "unsupported", disposition: "unsupported", diagnosticCode: "AB_MEL_MSG_001" },
    },
    types: {
      Boolean: { level: "supported", disposition: "exact" },
      Integer: { level: "supported", disposition: "exact" },
      Float: { level: "supported", disposition: "exact" },
      Array: { level: "supported", disposition: "exact" },
      Struct: { level: "conditional", disposition: "equivalent_lowering" },
      OpaqueVendorType: { level: "manual", disposition: "manual_port", requiresManualCompletion: true },
    },
    projectFeatures: {
      MultipleRoutines: { level: "supported", disposition: "exact" },
      GlobalTags: { level: "supported", disposition: "equivalent_lowering" },
      FunctionBlockDefinitions: { level: "supported", disposition: "equivalent_lowering" },
      HardwareModules: { level: "manual", disposition: "manual_port", requiresManualCompletion: true },
      IoMapping: { level: "manual", disposition: "manual_port", requiresManualCompletion: true },
    },
  };
}

function notImplementedLowering(lang: LanguageId): LoweringResult {
  return {
    ok: false,
    program: null,
    diagnostics: [{ code: "LOWERING_IR_PATH_PENDING", severity: "info", message: `Canonical-IR lowering for ${lang} arrives in Phase 5; emission currently uses the legacy bridge.`, stage: "lowering", language: lang, partial: true }],
    semanticLosses: [],
  };
}

function notImplementedEmit(lang: LanguageId): EmissionResult {
  return {
    ok: false,
    artifacts: [],
    diagnostics: [{ code: "EMIT_IR_PATH_PENDING", severity: "info", message: `Canonical-IR emission for ${lang} arrives in Phase 5; emission currently uses the legacy bridge.`, stage: "emit", language: lang, partial: true }],
    semanticLosses: [],
  };
}

/** Rockwell Logix ST backend — emits AB ST from a Mitsubishi source (legacy mel2ab). */
export const rockwellLogixStBackend: LanguageBackend & SourceEmitCapable = {
  id: "rockwell-logix-st",
  displayName: "Rockwell Logix Structured Text",
  supportedArtifacts: ["structured_text"],
  capabilities(): CapabilityManifest {
    return {
      language: "rockwell-logix-st",
      version: "0.1.0",
      operations: {
        Assignment: { level: "supported", disposition: "exact" },
        ConditionalBranch: { level: "supported", disposition: "exact" },
        CaseSelection: { level: "supported", disposition: "exact" },
        FunctionBlockInvoke: { level: "conditional", disposition: "equivalent_lowering", differences: ["MEL FB call → AB structure; verify semantics"], diagnosticCode: "MEL_AB_FB_001" },
        // Emitting a timer MEL→AB has no direct AB equivalent (enable is a rung
        // condition, not a named FB argument) → a manual-port template is
        // generated. This is lossy, matching the normalization disposition.
        TimerOnDelay: { level: "conditional", disposition: "lossy", differences: ["AB has no named-arg FB invoke; enable/preset must be re-wired manually"], requiresManualCompletion: true, diagnosticCode: "MEL_AB_TIMER_001" },
      },
      types: {
        Boolean: { level: "supported", disposition: "exact" },
        Integer: { level: "supported", disposition: "exact" },
        Float: { level: "supported", disposition: "exact" },
      },
      projectFeatures: {
        MultipleRoutines: { level: "supported", disposition: "exact" },
      },
    };
  },
  lower: () => notImplementedLowering("rockwell-logix-st"),
  emit: () => notImplementedEmit("rockwell-logix-st"),
  legacyEmitSources: () => ["mitsubishi-gx-st"],
  emitFromSource(sourceLanguage: LanguageId, source: string, ctx: EmissionContext) {
    const r = bridgeEmit(sourceLanguage, "rockwell-logix-st", source, "<input>", ctx.options);
    return { ok: r.ok, artifacts: r.artifacts, diagnostics: r.diagnostics, semanticLosses: [], stats: r.stats };
  },
};

// ── rockwell-l5k ──────────────────────────────────────────────────────────

export const rockwellL5kFrontend: LanguageFrontend = {
  id: "rockwell-l5k",
  displayName: "Rockwell Studio 5000 L5K Export",
  supportedArtifacts: ["project_exchange"],
  detect(artifact: SourceArtifact): DetectionResult {
    if (looksLikeL5K(artifact.content)) {
      return { confidence: 0.95, evidence: ["L5K signature present (IE_VER := / CONTROLLER header)"] };
    }
    return { confidence: 0, evidence: ["no L5K header signature"] };
  },
  parse(artifacts, _ctx): ParseResult {
    const src = artifacts.map((a) => a.content).join("\n");
    const ex = extractL5K(src);
    const units = [
      ...ex.stRoutines.map((r) => ({ id: `st:${r.parentName}/${r.name}`, name: r.name, kind: "routine" as const })),
      ...ex.ladderRoutines.map((r) => ({ id: `ld:${r.parentName}/${r.name}`, name: r.name, kind: "routine" as const })),
      ...ex.aois.map((a) => ({ id: `aoi:${a.name}`, name: a.name, kind: "function_block" as const })),
    ];
    return {
      ok: true,
      program: { irSchemaVersion: IR_SCHEMA_VERSION, sourceLanguage: "rockwell-l5k", units, raw: ex },
      diagnostics: [],
    };
  },
};

export { mitsubishiTargetManifest };
