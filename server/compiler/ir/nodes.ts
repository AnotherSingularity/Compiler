/**
 * Canonical IR node identity, provenance, and base shapes.
 *
 * Node IDs are DETERMINISTIC and structural: derived from a normalized
 * structural path (program/routine/statement/expression position) hashed to a
 * short opaque token. This makes an ID stable when the same source is compiled
 * again, when object insertion order changes, and regardless of any hash seed —
 * and changes only when the node's structural position/meaning changes. No
 * random UUIDs appear in compiler output (invariant E).
 */
import { createHash } from "crypto";
import type { LanguageId, ArtifactKind } from "../contracts/ids";
import type { SourceSpan } from "../contracts/source";

export type NodeId = string;

/** Provenance for a node derived from real source text. */
export interface SourceOrigin {
  kind: "source";
  sourceId: string;
  language: LanguageId;
  artifactKind: ArtifactKind;
  span: SourceSpan;
  /** Original AST node kind (e.g. "assign", "binary_op"). */
  sourceNodeKind?: string;
  /** Original vendor mnemonic where relevant (e.g. "TON") — provenance only. */
  sourceMnemonic?: string;
}

/** Provenance for a node the compiler synthesized (never a fake source span). */
export interface SyntheticOrigin {
  kind: "synthetic";
  /** Pass/component that generated it (e.g. "operation-normalization"). */
  generatedBy: string;
  /** Node IDs this was derived from. */
  derivedFrom: NodeId[];
  reason: string;
}

export type NodeOrigin = SourceOrigin | SyntheticOrigin;

/** Every IR node carries a stable id and provenance. */
export interface IrNodeBase {
  id: NodeId;
  origin: NodeOrigin;
}

/**
 * Compute a stable node id from a structural path. The path must uniquely and
 * deterministically describe the node's position in the program (e.g.
 * "MAIN/routine[0]/stmt[2]/assign/lhs"). Same path → same id, always.
 */
export function nodeIdFromPath(path: string): NodeId {
  const h = createHash("sha256").update(path, "utf8").digest("hex").slice(0, 12);
  return `ir_${h}`;
}

export function sourceOrigin(
  sourceId: string,
  language: LanguageId,
  artifactKind: ArtifactKind,
  span: SourceSpan,
  extra?: { sourceNodeKind?: string; sourceMnemonic?: string },
): SourceOrigin {
  return { kind: "source", sourceId, language, artifactKind, span, ...extra };
}

export function syntheticOrigin(generatedBy: string, derivedFrom: NodeId[], reason: string): SyntheticOrigin {
  return { kind: "synthetic", generatedBy, derivedFrom, reason };
}
