/**
 * L5K Extractor — pulls Structured Text routines out of a Studio 5000 L5K
 * export file.
 *
 * The L5K format wraps everything (controller config, IO modules, tags,
 * programs, AOIs) in a Pascal-flavored DSL. ST routines live inside
 * `ST_ROUTINE <name> ... END_ST_ROUTINE` blocks. Each line of ST source is
 * prefixed with a single quote (L5K's "literal text" sentinel).
 *
 * Ladder logic routines (`ROUTINE <name>` with `RC:` / `N:` lines) are a
 * different language — not Structured Text — and are reported but not
 * extracted.
 *
 * Heuristic for "is this an L5K?": presence of `IE_VER :=` or
 * `CONTROLLER <name> (` in the first 50 lines.
 */

export interface L5KRoutine {
  /** Routine name (typically "Logic") */
  name: string;
  /** Parent container kind */
  parentKind: "AOI" | "PROGRAM" | "TASK" | null;
  /** Parent container name (e.g. AOI name or program name) */
  parentName: string;
  /** ST source code, with the L5K quote-prefix stripped from each line */
  source: string;
  /** Line in the original L5K where ST_ROUTINE started */
  sourceStartLine: number;
}

export interface L5KLadderRoutine {
  name: string;
  parentKind: "AOI" | "PROGRAM" | "TASK" | null;
  parentName: string;
  sourceStartLine: number;
  ruleCount: number;
}

export interface L5KExtractionResult {
  /** Whether the input appears to be an L5K file */
  isL5K: boolean;
  /** L5K version (from `IE_VER := X.Y;`) */
  ieVer: string | null;
  /** Controller name */
  controllerName: string | null;
  /** All ST routines found, in source order */
  stRoutines: L5KRoutine[];
  /** Ladder routines we noted but didn't extract */
  ladderRoutines: L5KLadderRoutine[];
}

const L5K_SIGNATURE = /(?:^IE_VER\s*:=|\bCONTROLLER\s+\w+\s*\()/m;

export function looksLikeL5K(input: string): boolean {
  const head = input.length > 2000 ? input.slice(0, 2000) : input;
  return L5K_SIGNATURE.test(head);
}

export function extractL5K(input: string): L5KExtractionResult {
  const result: L5KExtractionResult = {
    isL5K: looksLikeL5K(input),
    ieVer: null,
    controllerName: null,
    stRoutines: [],
    ladderRoutines: [],
  };

  if (!result.isL5K) return result;

  // L5K exports are UTF-8 with CRLF line endings; normalize.
  const lines = input.split(/\r?\n/);

  let parentKind: L5KRoutine["parentKind"] = null;
  let parentName = "";
  // Track nesting depth so a routine's parent is correctly identified even
  // if AOIs and PROGRAMs interleave.
  const containerStack: Array<{
    kind: "AOI" | "PROGRAM" | "TASK";
    name: string;
  }> = [];

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Header metadata
    if (!result.ieVer) {
      const ie = trimmed.match(/^IE_VER\s*:=\s*([0-9.]+)\s*;/);
      if (ie) result.ieVer = ie[1];
    }
    if (!result.controllerName) {
      const ctl = trimmed.match(/^CONTROLLER\s+(\w+)\s*\(/);
      if (ctl) result.controllerName = ctl[1];
    }

    // Container open/close — track AOI and PROGRAM nesting
    const aoiOpen = trimmed.match(/^ADD_ON_INSTRUCTION_DEFINITION\s+(\w+)/);
    if (aoiOpen) {
      containerStack.push({ kind: "AOI", name: aoiOpen[1] });
      parentKind = "AOI";
      parentName = aoiOpen[1];
      i++;
      continue;
    }
    if (/^END_ADD_ON_INSTRUCTION_DEFINITION\b/.test(trimmed)) {
      if (containerStack.length > 0) containerStack.pop();
      const top = containerStack[containerStack.length - 1];
      parentKind = top?.kind ?? null;
      parentName = top?.name ?? "";
      i++;
      continue;
    }
    const progOpen = trimmed.match(/^PROGRAM\s+(\w+)/);
    if (progOpen) {
      containerStack.push({ kind: "PROGRAM", name: progOpen[1] });
      parentKind = "PROGRAM";
      parentName = progOpen[1];
      i++;
      continue;
    }
    if (/^END_PROGRAM\b/.test(trimmed)) {
      if (containerStack.length > 0) containerStack.pop();
      const top = containerStack[containerStack.length - 1];
      parentKind = top?.kind ?? null;
      parentName = top?.name ?? "";
      i++;
      continue;
    }

    // ST_ROUTINE — extract source lines until END_ST_ROUTINE
    const stOpen = trimmed.match(/^ST_ROUTINE\s+(\w+)/);
    if (stOpen) {
      const routineName = stOpen[1];
      const startLine = i + 1; // 1-indexed
      const stLines: string[] = [];
      i++;
      while (i < lines.length) {
        const r = lines[i];
        if (/^\s*END_ST_ROUTINE\b/.test(r)) {
          i++;
          break;
        }
        // Each ST line in L5K is wrapped: leading whitespace, single quote,
        // then the ST source, no trailing quote (the quote opens the line
        // and the newline closes it). Strip the leading quote + whitespace.
        // Some lines may be empty.
        const m = r.match(/^\s*'(.*)$/);
        if (m) {
          stLines.push(m[1]);
        } else if (r.trim() === "") {
          stLines.push("");
        } else {
          // Defensive: include the raw line so we don't silently drop content
          stLines.push(r.trim());
        }
        i++;
      }
      result.stRoutines.push({
        name: routineName,
        parentKind,
        parentName,
        source: stLines.join("\n"),
        sourceStartLine: startLine,
      });
      continue;
    }

    // Ladder ROUTINE — record but don't extract (different language)
    const rllOpen = trimmed.match(/^ROUTINE\s+(\w+)/);
    if (rllOpen) {
      const routineName = rllOpen[1];
      const startLine = i + 1;
      let ruleCount = 0;
      i++;
      while (i < lines.length) {
        const r = lines[i];
        if (/^\s*END_ROUTINE\b/.test(r)) {
          i++;
          break;
        }
        if (/^\s*N:\s/.test(r)) ruleCount++;
        i++;
      }
      result.ladderRoutines.push({
        name: routineName,
        parentKind,
        parentName,
        sourceStartLine: startLine,
        ruleCount,
      });
      continue;
    }

    i++;
  }

  return result;
}

/**
 * Concatenate all ST routines from an extraction into a single ST source
 * with provenance headers, suitable for piping into the existing
 * translate() entrypoint.
 *
 * If the L5K contains no ST routines, returns an empty string.
 */
export function joinExtractedRoutines(result: L5KExtractionResult): string {
  if (result.stRoutines.length === 0) return "";

  const chunks: string[] = [];
  chunks.push(
    `(* L5K extraction: ${result.stRoutines.length} ST routine(s) from controller "${result.controllerName ?? "<unknown>"}" (IE_VER ${result.ieVer ?? "?"}) *)`,
  );
  if (result.ladderRoutines.length > 0) {
    chunks.push(
      `(* Note: ${result.ladderRoutines.length} ladder (RLL) routine(s) skipped — ladder is not Structured Text *)`,
    );
  }
  chunks.push("");

  for (const r of result.stRoutines) {
    const parent = r.parentKind
      ? `${r.parentKind.toLowerCase()} ${r.parentName}`
      : "<top-level>";
    chunks.push(
      `(* ── ST_ROUTINE ${r.name} in ${parent} (L5K line ${r.sourceStartLine}) ── *)`,
    );
    chunks.push(r.source);
    chunks.push("");
  }

  return chunks.join("\n");
}
