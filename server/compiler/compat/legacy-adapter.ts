/**
 * Legacy compatibility adapter (Phase 1 surface, Phase 2 routing).
 *
 * Bridges the proof-of-concept `translate(source, "ab2mel" | "mel2ab")` entry
 * point to the language-neutral `CompileRequest` / `CompileResult` contract, and
 * routes through the registry orchestrator (Phase 2). Behavior stays equivalent
 * to the protected legacy pipeline (Phase 1 gate) because the orchestrator's
 * built-in backends delegate to the unchanged `translate()` via the bridge.
 *
 * This adapter is the only place, besides the bridge, that maps legacy
 * directions onto languages. The central orchestrator has no `ab2mel`/`mel2ab`.
 */
import { looksLikeL5K } from "../l5k_extract";
import { compileWithRegistry } from "../registry/orchestrator";
import { defaultRegistry } from "../registry/default-registry";
import {
  type LanguageId,
  type SourceLanguageSelector,
  type CompileRequest,
  type CompileResult,
  type SourceArtifact,
  isLanguageId,
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
  return { sourceLanguage, targetLanguage, sourceArtifacts: [{ id: "<input>", content: source }], options };
}

/**
 * Resolve an "auto" selector the way the legacy pipeline did — L5K vs Logix ST
 * by signature, else the language that pairs with the requested target. This
 * mirrors legacy behavior deterministically instead of relying on the registry's
 * (correctly) ambiguity-averse detector for the legacy path.
 */
function resolveLegacySource(
  selector: SourceLanguageSelector,
  source: string,
  target: LanguageId,
): LanguageId {
  if (selector !== "auto") return selector;
  if (looksLikeL5K(source)) return "rockwell-l5k";
  if (target === "mitsubishi-gx-st") return "rockwell-logix-st";
  if (target === "rockwell-logix-st") return "mitsubishi-gx-st";
  return "iec-61131-3-st";
}

function concatArtifacts(artifacts: SourceArtifact[]): string {
  return artifacts.map((a) => a.content).join("\n");
}

/**
 * Compile a request via the registry orchestrator. Throws `CompileRequestError`
 * for malformed requests (unknown languages, empty source); returns a
 * fail-closed `CompileResult` for unsupported-but-valid routes.
 */
export function compile(request: CompileRequest): CompileResult {
  if (request.sourceLanguage !== "auto" && !isLanguageId(request.sourceLanguage)) {
    throw new CompileRequestError("CAPABILITY_UNKNOWN_SOURCE_LANGUAGE", `Unknown source language: ${String(request.sourceLanguage)}`);
  }
  if (!isLanguageId(request.targetLanguage)) {
    throw new CompileRequestError("CAPABILITY_UNKNOWN_TARGET_LANGUAGE", `Unknown target language: ${String(request.targetLanguage)}`);
  }
  if (!Array.isArray(request.sourceArtifacts) || request.sourceArtifacts.length === 0) {
    throw new CompileRequestError("PROJECT_NO_SOURCE_ARTIFACTS", "CompileRequest requires at least one source artifact");
  }
  if (request.sourceArtifacts.every((a) => !a.content || a.content.trim() === "")) {
    throw new CompileRequestError("PROJECT_EMPTY_SOURCE", "All source artifacts are empty");
  }

  // Resolve the legacy "auto" selector to an explicit language (legacy-mirroring),
  // then let the registry orchestrator route + emit. This keeps the two
  // proof-of-concept routes behaviorally identical while exercising the registry.
  const source = concatArtifacts(request.sourceArtifacts);
  const resolvedSource = resolveLegacySource(request.sourceLanguage, source, request.targetLanguage);
  const resolvedRequest: CompileRequest = { ...request, sourceLanguage: resolvedSource };
  return compileWithRegistry(resolvedRequest, defaultRegistry());
}

/** Legacy convenience: `compileLegacy(source, "ab2mel")` — direction → request → compile. */
export function compileLegacy(
  source: string,
  direction: LegacyDirection,
  options?: { memoryMap?: string; labelsCsv?: string },
): CompileResult {
  return compile(legacyRequest(source, direction, options));
}
