/**
 * Language registry (Phase 2).
 *
 * Requirements (from the mandate):
 *  - No global mutable registry hidden in module side effects — callers
 *    construct a registry and register plugins explicitly.
 *  - Duplicate registration fails deterministically.
 *  - Contents are inspectable, in a deterministic (id-sorted) order.
 *  - Detection exposes confidence + evidence and never silently guesses on ties.
 */
import type { LanguageId } from "../contracts";
import type { LanguageFrontend, LanguageBackend, DetectionResult } from "../contracts";
import type { SourceArtifact } from "../contracts";

export class RegistryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
  }
}

export interface DetectionCandidate {
  language: LanguageId;
  confidence: number;
  evidence: string[];
}

export interface DetectionOutcome {
  /** Chosen language, or null when detection is ambiguous/empty. */
  language: LanguageId | null;
  /** Why no language was chosen, when `language` is null. */
  reason?: "no_candidates" | "ambiguous";
  /** All candidates, sorted deterministically (confidence desc, then id asc). */
  candidates: DetectionCandidate[];
}

/** Minimum confidence gap required to disambiguate the top two candidates. */
const AMBIGUITY_MARGIN = 0.15;
/** Minimum confidence for a candidate to be considered at all. */
const MIN_CONFIDENCE = 0.1;

export class LanguageRegistry {
  private readonly frontends = new Map<LanguageId, LanguageFrontend>();
  private readonly backends = new Map<LanguageId, LanguageBackend>();

  registerFrontend(frontend: LanguageFrontend): void {
    if (this.frontends.has(frontend.id)) {
      throw new RegistryError("REGISTRY_DUPLICATE_FRONTEND", `Frontend already registered: ${frontend.id}`);
    }
    this.frontends.set(frontend.id, frontend);
  }

  registerBackend(backend: LanguageBackend): void {
    if (this.backends.has(backend.id)) {
      throw new RegistryError("REGISTRY_DUPLICATE_BACKEND", `Backend already registered: ${backend.id}`);
    }
    this.backends.set(backend.id, backend);
  }

  getFrontend(id: LanguageId): LanguageFrontend | undefined {
    return this.frontends.get(id);
  }

  getBackend(id: LanguageId): LanguageBackend | undefined {
    return this.backends.get(id);
  }

  /** Frontends in deterministic id order. */
  listFrontends(): LanguageFrontend[] {
    return [...this.frontends.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Backends in deterministic id order. */
  listBackends(): LanguageBackend[] {
    return [...this.backends.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Inspectable snapshot of registered ids (deterministic order). */
  inventory(): { frontends: LanguageId[]; backends: LanguageId[] } {
    return {
      frontends: this.listFrontends().map((f) => f.id),
      backends: this.listBackends().map((b) => b.id),
    };
  }

  /**
   * Run every frontend's detector against an artifact. Returns a deterministic,
   * fully-ordered outcome. Never silently picks a language when the top two
   * candidates are within the ambiguity margin (invariant: fail closed on
   * ambiguous automatic detection).
   */
  detect(artifact: SourceArtifact): DetectionOutcome {
    const candidates: DetectionCandidate[] = [];
    for (const fe of this.listFrontends()) {
      const r: DetectionResult = fe.detect(artifact);
      if (r.confidence >= MIN_CONFIDENCE) {
        candidates.push({ language: fe.id, confidence: r.confidence, evidence: r.evidence });
      }
    }
    candidates.sort((a, b) => (b.confidence - a.confidence) || a.language.localeCompare(b.language));

    if (candidates.length === 0) {
      return { language: null, reason: "no_candidates", candidates };
    }
    if (
      candidates.length >= 2 &&
      candidates[0].confidence - candidates[1].confidence < AMBIGUITY_MARGIN
    ) {
      return { language: null, reason: "ambiguous", candidates };
    }
    return { language: candidates[0].language, candidates };
  }
}
