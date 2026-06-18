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
  /** Structured rungs ready for the ladder emitter to consume. */
  rungs: LadderRungInput[];
}
/** A single rung extracted from a ROUTINE block. */
export interface LadderRungInput {
  /** 1-indexed rung number within the routine */
  number: number;
  /** Rung comment text (RC), if any. Joined across multi-line concatenated strings. */
  comment: string | null;
  /** Rung logic source text (N), verbatim — what the parser will tokenize */
  source: string;
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
    // Ladder ROUTINE — record and extract every rung
    const rllOpen = trimmed.match(/^ROUTINE\s+(\w+)/);
    if (rllOpen) {
      const routineName = rllOpen[1];
      const startLine = i + 1;
      const rungs: LadderRungInput[] = [];
      let pendingComment: string | null = null;
      let rungNumber = 0;
      i++;
      while (i < lines.length) {
        const r = lines[i];
        if (/^\s*END_ROUTINE\b/.test(r)) {
          i++;
          break;
        }
        // RC: "comment text" — may span multiple lines via string concatenation
        const rcMatch = r.match(/^\s*RC:\s*(.*)$/);
        if (rcMatch) {
          // Collect the full RC payload (may extend across continuation lines
          // until a semicolon-terminating line appears)
          let payload = rcMatch[1];
          while (!payload.trimEnd().endsWith(";")) {
            i++;
            if (i >= lines.length) break;
            payload += " " + lines[i].trim();
          }
          // Strip the trailing semicolon and extract quoted segments
          payload = payload.replace(/;\s*$/, "");
          // Pull out quoted strings; treat $N as a comment newline marker (just join with space)
          const strParts: string[] = [];
          const re = /"((?:[^"\\]|\\.)*)"/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(payload)) !== null) {
            strParts.push(m[1].replace(/\$N/g, " ").replace(/\$T/g, "  ").replace(/\$\$/g, "$"));
          }
          pendingComment = strParts.join(" ").trim();
          i++;
          continue;
        }
        // N: <rung logic>; — possibly spanning multiple lines
        const nMatch = r.match(/^\s*N:\s*(.*)$/);
        if (nMatch) {
          let payload = nMatch[1];
          while (!payload.trimEnd().endsWith(";")) {
            i++;
            if (i >= lines.length) break;
            payload += " " + lines[i].trim();
          }
          // Strip trailing semicolon for cleaner parser input
          payload = payload.replace(/;\s*$/, "");
          rungNumber++;
          rungs.push({
            number: rungNumber,
            comment: pendingComment,
            source: payload.trim(),
          });
          pendingComment = null;
          i++;
          continue;
        }
        // Skip blank/unrecognized lines inside the routine body
        i++;
      }
      result.ladderRoutines.push({
        name: routineName,
        parentKind,
        parentName,
        sourceStartLine: startLine,
        ruleCount: rungs.length,
        rungs,
      });
      continue;
    }
    i++;
  }
  return result;
}
/**
 * Concatenate all routines from an extraction into a single ST source
 * with provenance headers, suitable for piping into the existing
 * translate() entrypoint.
 *
 * Both ST routines (verbatim) and ladder routines (via ladder_emitter) are
 * included. Returns the full ST text plus a coverage report.
 */
export interface JoinedResult {
  /** Joined ST source ready to feed the existing parser/emitter pipeline */
  source: string;
  /** Number of ladder routines successfully translated to ST */
  ladderTranslated: number;
  /** Total ladder rungs across all routines */
  ladderRungs: number;
  /** Ladder rungs that failed to parse */
  ladderFailedRungs: number;
  /** Union of unique instruction names that became MANUAL_PORT */
  manualPortInstructions: string[];
  /** Warnings from ladder emission (one-shots, timer notes, etc.) */
  ladderWarnings: string[];
}
export function joinExtractedRoutines(result: L5KExtractionResult): JoinedResult {
  if (result.stRoutines.length === 0 && result.ladderRoutines.length === 0) {
    return {
      source: "",
      ladderTranslated: 0,
      ladderRungs: 0,
      ladderFailedRungs: 0,
      manualPortInstructions: [],
      ladderWarnings: [],
    };
  }
  const chunks: string[] = [];
  const totalRoutines = result.stRoutines.length + result.ladderRoutines.length;
  chunks.push(
    `(* L5K extraction: ${totalRoutines} routine(s) from controller "${result.controllerName ?? "<unknown>"}" (IE_VER ${result.ieVer ?? "?"}) *)`,
  );
  chunks.push(
    `(*   ${result.stRoutines.length} ST routine(s) + ${result.ladderRoutines.length} ladder routine(s) translated to ST *)`,
  );
  chunks.push("");
  // Emit ST routines first (in source order they may be interleaved with ladder,
  // but for output clarity we group)
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
  // Then ladder routines, translated to ST
  // Lazy require to avoid circular dependency at module load
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { emitLadderRoutine } = require("./ladder_emitter");
  let ladderTranslated = 0;
  let ladderRungs = 0;
  let ladderFailedRungs = 0;
  const manualPortSet = new Set<string>();
  const ladderWarnings: string[] = [];
  for (const r of result.ladderRoutines) {
    const parent = r.parentKind
      ? `${r.parentKind.toLowerCase()} ${r.parentName}`
      : "<top-level>";
    chunks.push(
      `(* ── ROUTINE ${r.name} (ladder→ST) in ${parent} (L5K line ${r.sourceStartLine}, ${r.ruleCount} rungs) ── *)`,
    );
    if (r.rungs.length === 0) {
      chunks.push("// (empty routine)");
      chunks.push("");
      continue;
    }
    const out = emitLadderRoutine(r.rungs);
    chunks.push(out.st);
    chunks.push("");
    ladderTranslated++;
    ladderRungs += out.rungCount;
    ladderFailedRungs += out.failedRungCount;
    for (const mp of out.manualPortInstructions) manualPortSet.add(mp);
    for (const w of out.warnings) ladderWarnings.push(`${parent}/${r.name}: ${w}`);
  }
  return {
    source: chunks.join("\n"),
    ladderTranslated,
    ladderRungs,
    ladderFailedRungs,
    manualPortInstructions: Array.from(manualPortSet).sort(),
    ladderWarnings,
  };
}
