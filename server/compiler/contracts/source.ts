/**
 * Source artifact + provenance contracts.
 *
 * SourceSpan is the provenance carrier (invariant F). Every canonical node and
 * diagnostic that can be traced should carry one. Offsets are 0-based byte/char
 * offsets into the identified source; line/column are 1-based for display.
 */
import type { ArtifactKind } from "./ids";

export interface SourcePosition {
  offset: number;
  line: number;
  column: number;
}

export interface SourceSpan {
  sourceId: string;
  start: SourcePosition;
  end: SourcePosition;
}

/** One unit of input to the compiler (a file, a pasted buffer, an export blob). */
export interface SourceArtifact {
  /** Stable id used as `SourceSpan.sourceId` (e.g. filename or "<input>"). */
  id: string;
  /** Declared/known artifact kind, or undefined to let detection decide. */
  kind?: ArtifactKind;
  /** Original filename if uploaded (sanitized by callers; never trusted as a path). */
  filename?: string;
  /** UTF-8 text content. */
  content: string;
}

/** Build a whole-artifact span (line 1..lastLine) — used when finer spans aren't available yet. */
export function wholeArtifactSpan(artifact: SourceArtifact): SourceSpan {
  const content = artifact.content;
  const lines = content.split("\n");
  const lastLineLen = lines.length > 0 ? lines[lines.length - 1].length : 0;
  return {
    sourceId: artifact.id,
    start: { offset: 0, line: 1, column: 1 },
    end: {
      offset: content.length,
      line: Math.max(1, lines.length),
      column: lastLineLen + 1,
    },
  };
}

/** Build a single-line span (used to lift legacy line-only diagnostics into provenance). */
export function lineSpan(sourceId: string, line: number): SourceSpan {
  const safeLine = Number.isFinite(line) && line > 0 ? Math.floor(line) : 1;
  return {
    sourceId,
    start: { offset: -1, line: safeLine, column: 1 },
    end: { offset: -1, line: safeLine, column: 1 },
  };
}
