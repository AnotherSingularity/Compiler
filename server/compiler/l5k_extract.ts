/**
 * L5K extraction — phase 2.
 *
 * Studio 5000 L5K exports are not raw ST. They wrap controller config, IO
 * modules, tags, UDTs, AOIs, programs, and routines in a Pascal-flavored
 * DSL. This module walks the L5K text and produces a structured extraction
 * result that downstream emitters consume to produce:
 *
 *   - main ST output (program routines)
 *   - FB definitions (AOIs as IEC FUNCTION_BLOCKs)
 *   - global labels CSV (controller-scope tags + UDT comments)
 *   - IO map YAML (modules, slots, catalog numbers, data sizes)
 *
 * The extractor is line-oriented and recursive-descent. It uses a small
 * shared attribute-list parser (`parseAttrList`) for the `(key := value,
 * key := value, ...)` syntax that appears on every block opener and every
 * tag declaration.
 *
 * Lossless preservation is NOT a goal here. The structured extraction is
 * an intermediate form; the original L5K isn't reconstructed from it.
 */
// ─── ROUTINE (existing — keep stable) ──────────────────────────────────
export interface L5KRoutine {
  /** Routine name */
  name: string;
  /** Container kind, if known */
  parentKind: "AOI" | "PROGRAM" | "TASK" | null;
  /** Container name */
  parentName: string;
  /** The ST source code, line-by-line with leading quote stripped */
  source: string;
  /** Line in the original L5K where ST_ROUTINE started */
  sourceStartLine: number;
}
export interface L5KLadderRoutine {
  name: string;
  parentKind: "AOI" | "PROGRAM" | "TASK" | null;
  parentName: string;
  /** Line where ROUTINE started in source */
  sourceStartLine: number;
  /** Number of rungs */
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
// ─── TAG (new) ─────────────────────────────────────────────────────────
export interface L5KTag {
  name: string;
  type: string;                      // "BOOL", "DINT", "TIMER", "MY_UDT", etc.
  arrayDims: number[];               // [256] for BOOL[256], [] for scalar
  /** Description attribute, if present */
  description: string | null;
  /** Indexed COMMENT[N] entries — element-level descriptions on array tags */
  comments: { index: number; text: string }[];
  /** ExternalAccess attribute */
  externalAccess: string | null;
  /** Class attribute (Standard, Safety) */
  className: string | null;
  /** Container scope */
  parentKind: "CONTROLLER" | "PROGRAM" | "AOI_LOCAL";
  parentName: string;                // controller name, program name, or AOI name
  /** Raw initial value expression, if present (text after `:=`, before `;`) */
  initial: string | null;
}
// ─── DATATYPE (UDT) — new ──────────────────────────────────────────────
export interface L5KDataType {
  name: string;
  familyType: string;                // "NoFamily" | "String" | etc.
  members: L5KDataTypeMember[];
}
export type L5KDataTypeMember =
  | {
      kind: "field";
      name: string;
      type: string;                  // "BOOL", "DINT", another UDT name, etc.
      arrayDims: number[];
      hidden: boolean;
      description: string | null;
    }
  | {
      kind: "bit";
      name: string;
      parentField: string;           // backing SINT/INT/DINT field name
      bitOffset: number;
      description: string | null;
    };
// ─── MODULE + CONNECTION — new ─────────────────────────────────────────
export interface L5KModule {
  name: string;
  parent: string;                    // "Local" (chassis) or another module name
  catalogNumber: string;
  vendor: number;
  productType: number;
  productCode: number;
  major: number;
  minor: number;
  slot: number | null;
  /** Whether this slot is a safety module */
  safetyEnabled: boolean;
  /** The raw remaining attributes for human review */
  attrs: { key: string; value: string }[];
  connections: L5KConnection[];
}
export interface L5KConnection {
  name: string;                      // "SafetyInput", "StandardInput", etc.
  /** Attribute key/value pairs from the CONNECTION opener */
  attrs: { key: string; value: string }[];
  /** Names of data blocks present (InputData, OutputData, CommandData, …) */
  dataBlocks: string[];
}
// ─── AOI definition — new ──────────────────────────────────────────────
export interface L5KAoiDef {
  name: string;
  revision: string | null;
  description: string | null;
  /** Other AOI-level attributes for human review */
  attrs: { key: string; value: string }[];
  /** PARAMETERS block (Input/Output/InOut params) */
  parameters: L5KAoiParam[];
  /** LOCAL_TAGS block (internal state, like local VARs) */
  localTags: L5KTag[];
  /** Line number in L5K where the AOI block began */
  sourceStartLine: number;
}
export interface L5KAoiParam {
  name: string;
  type: string;
  arrayDims: number[];
  usage: "Input" | "Output" | "InOut";
  required: boolean;
  visible: boolean;
  description: string | null;
  externalAccess: string | null;
  defaultData: string | null;
}
// ─── Result ────────────────────────────────────────────────────────────
export interface L5KExtractionResult {
  isL5K: boolean;
  ieVer: string | null;
  controllerName: string | null;
  stRoutines: L5KRoutine[];
  ladderRoutines: L5KLadderRoutine[];
  /** Phase 2 additions — empty arrays mean the section wasn't present. */
  tags: L5KTag[];
  dataTypes: L5KDataType[];
  modules: L5KModule[];
  aois: L5KAoiDef[];
}
// ═══════════════════════════════════════════════════════════════════════
// Detection
// ═══════════════════════════════════════════════════════════════════════
export function looksLikeL5K(input: string): boolean {
  const head = input.slice(0, 4096);
  return /^IE_VER\s*:=\s*[0-9.]+\s*;/m.test(head) || /^CONTROLLER\s+\w+/m.test(head);
}
// ═══════════════════════════════════════════════════════════════════════
// Shared attribute-list parser
// ═══════════════════════════════════════════════════════════════════════
/**
 * Parse an attribute list of the form `(key := value, key := value, ...)`.
 * Returns ordered key/value pairs. Values are returned verbatim (quotes and
 * brackets preserved). Handles multi-line lists, quoted strings (single and
 * double), and bracketed values like `2#0000_0001` or `[1, 2, 3]`.
 *
 * Input is the text BETWEEN the opening `(` and closing `)`, with newlines
 * already collapsed to single spaces (caller is responsible for that).
 */
function parseAttrList(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  if (!text || !text.trim()) return out;
  // Split by commas that are NOT inside strings or brackets/parens.
  const parts: string[] = [];
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  let buf = "";
  for (let p = 0; p < text.length; p++) {
    const ch = text[p];
    if (inStr) {
      buf += ch;
      if (ch === "\\" && p + 1 < text.length) { buf += text[++p]; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; buf += ch; continue; }
    if (ch === "(" || ch === "[") { depth++; buf += ch; continue; }
    if (ch === ")" || ch === "]") { depth--; buf += ch; continue; }
    if (ch === "," && depth === 0) {
      if (buf.trim()) parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  for (const p of parts) {
    const idx = p.indexOf(":=");
    if (idx < 0) continue;
    const key = p.slice(0, idx).trim();
    const value = p.slice(idx + 2).trim();
    if (key) out.push({ key, value });
  }
  return out;
}
/**
 * Find the matching `)` for the `(` at position `openIdx` in the joined
 * text. Respects strings and nested brackets. Returns the index of the
 * matching `)` or -1 if not found.
 */
function findMatchingParen(text: string, openIdx: number): number {
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  for (let p = openIdx; p < text.length; p++) {
    const ch = text[p];
    if (inStr) {
      if (ch === "\\" && p + 1 < text.length) { p++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return p; }
  }
  return -1;
}
/** Strip surrounding double-quotes and process L5K string escapes. */
function unquoteString(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(/^"((?:[^"\\]|\\.|\$.)*)"$/);
  if (!m) return trimmed;
  return m[1]
    .replace(/\$N/g, "\n")
    .replace(/\$T/g, "\t")
    .replace(/\$\$/g, "$")
    .replace(/\$"/g, '"')
    .replace(/\\(.)/g, "$1");
}
function attrValue(attrs: { key: string; value: string }[], key: string): string | null {
  for (const a of attrs) if (a.key === key) return a.value;
  return null;
}
function attrString(attrs: { key: string; value: string }[], key: string): string | null {
  const v = attrValue(attrs, key);
  return v ? unquoteString(v) : null;
}
function attrNumber(attrs: { key: string; value: string }[], key: string): number | null {
  const v = attrValue(attrs, key);
  if (v === null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
function attrBool(attrs: { key: string; value: string }[], key: string): boolean {
  const v = attrValue(attrs, key);
  return v === "Yes" || v === "1" || v === "true";
}
// ═══════════════════════════════════════════════════════════════════════
// Block readers — read text between OPENER and END_X, joining continuation
// lines so the attr-list parser sees one logical string.
// ═══════════════════════════════════════════════════════════════════════
/**
 * Read forward from `startIdx` until a line matches `terminator`. Returns
 * the joined body (lines between opener and terminator) and the index AT
 * the terminator line (caller increments past).
 */
function readBlock(
  lines: string[],
  startIdx: number,
  terminator: RegExp,
): { body: string[]; endIdx: number } {
  const body: string[] = [];
  let i = startIdx;
  while (i < lines.length) {
    if (terminator.test(lines[i])) return { body, endIdx: i };
    body.push(lines[i]);
    i++;
  }
  return { body, endIdx: i };
}
/**
 * Read attribute-list payload that opens at some column on the opener line
 * and may span continuation lines until the matching `)`. Returns the
 * inner text (between the parens) and how many lines were consumed.
 */
function readAttrListFromHere(lines: string[], startIdx: number, openColInLine: number): { inner: string; consumed: number } {
  // Concatenate from `(` onward across lines until matching `)`.
  let joined = lines[startIdx].slice(openColInLine);
  let consumed = 1;
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  let closedAt = -1;
  for (let p = 0; p < joined.length; p++) {
    const ch = joined[p];
    if (inStr) {
      if (ch === "\\" && p + 1 < joined.length) { p++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) { closedAt = p; break; } }
  }
  while (closedAt < 0 && startIdx + consumed < lines.length) {
    const more = lines[startIdx + consumed];
    consumed++;
    joined += " " + more.trim();
    for (let p = joined.length - more.trim().length - 1; p < joined.length; p++) {
      const ch = joined[p];
      if (inStr) {
        if (ch === "\\" && p + 1 < joined.length) { p++; continue; }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) { closedAt = p; break; } }
    }
  }
  if (closedAt < 0) return { inner: "", consumed };
  // joined[0] is the `(`; inner is between [1, closedAt)
  return { inner: joined.slice(1, closedAt), consumed };
}
// ═══════════════════════════════════════════════════════════════════════
// Parsers
// ═══════════════════════════════════════════════════════════════════════
/**
 * Parse a single TAG declaration. Returns null if the line isn't a tag.
 * Tag declarations span lines: `name : type[arr] (attrs) := initial;`.
 * Caller supplies the full multi-line text already joined.
 */
function parseTagDecl(text: string, parentKind: L5KTag["parentKind"], parentName: string): L5KTag | null {
  // name : type [arr] [(attrs)] [:= initial];
  // Examples:
  //   ABN : BOOL[256] (Description := "SPARE", COMMENT[2] := "...");
  //   CV_X_Y_OK : BOOL (Class := Standard, RADIX := Decimal) := 1;
  //   CV_ZONE_1 : CV_ZONE_ID (Class := Standard) := [...];
  const m = text.match(/^\s*(\w+)\s*:\s*([A-Za-z_]\w*)\s*(\[[\d, ]+\])?\s*/);
  if (!m) return null;
  const name = m[1];
  const type = m[2];
  const arrayDims = m[3]
    ? m[3].slice(1, -1).split(",").map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n))
    : [];
  let rest = text.slice(m[0].length);
  let attrs: { key: string; value: string }[] = [];
  if (rest.startsWith("(")) {
    const close = findMatchingParen(rest, 0);
    if (close > 0) {
      attrs = parseAttrList(rest.slice(1, close));
      rest = rest.slice(close + 1).trim();
    }
  }
  let initial: string | null = null;
  if (rest.startsWith(":=")) {
    const semi = rest.lastIndexOf(";");
    initial = (semi > 2 ? rest.slice(2, semi) : rest.slice(2)).trim();
  }
  // Extract COMMENT[N] indexed entries
  const comments: { index: number; text: string }[] = [];
  let description: string | null = null;
  for (const a of attrs) {
    if (a.key === "Description") description = unquoteString(a.value);
    else {
      const cm = a.key.match(/^COMMENT\[(\d+)\]$/);
      if (cm) comments.push({ index: parseInt(cm[1], 10), text: unquoteString(a.value) });
    }
  }
  return {
    name, type, arrayDims, description, comments,
    externalAccess: attrString(attrs, "ExternalAccess"),
    className: attrString(attrs, "Class"),
    parentKind, parentName,
    initial,
  };
}
/** Parse a DATATYPE block body (lines between opener and END_DATATYPE). */
function parseDataTypeMembers(body: string[]): L5KDataTypeMember[] {
  const members: L5KDataTypeMember[] = [];
  for (const raw of body) {
    const line = raw.trim();
    if (!line) continue;
    // BIT name parentField : offset [(attrs)];
    const bitM = line.match(/^BIT\s+(\w+)\s+(\w+)\s*:\s*(\d+)\s*(?:\((.*?)\))?\s*;/);
    if (bitM) {
      const attrs = bitM[4] ? parseAttrList(bitM[4]) : [];
      members.push({
        kind: "bit",
        name: bitM[1],
        parentField: bitM[2],
        bitOffset: parseInt(bitM[3], 10),
        description: attrString(attrs, "Description"),
      });
      continue;
    }
    // type name [arr] [(Hidden := 1[, Description := "..."])];
    const fieldM = line.match(/^(\w+)\s+(\w+)\s*(\[[\d, ]+\])?\s*(?:\((.*?)\))?\s*;/);
    if (fieldM) {
      const attrs = fieldM[4] ? parseAttrList(fieldM[4]) : [];
      members.push({
        kind: "field",
        name: fieldM[2],
        type: fieldM[1],
        arrayDims: fieldM[3]
          ? fieldM[3].slice(1, -1).split(",").map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n))
          : [],
        hidden: attrBool(attrs, "Hidden"),
        description: attrString(attrs, "Description"),
      });
      continue;
    }
  }
  return members;
}
/**
 * Iterate over the lines of a TAG/LOCAL_TAGS/PARAMETERS body and yield each
 * complete tag declaration (which may span multiple lines, terminated by ;).
 */
function* iterateTagDeclLines(body: string[]): Generator<string> {
  let buf = "";
  for (const raw of body) {
    const stripped = raw.replace(/\r$/, "");
    if (!stripped.trim()) continue;
    buf += (buf ? " " : "") + stripped.trim();
    // A complete decl ends with a ; that's not inside a bracket/paren/string.
    if (isCompleteStatement(buf)) {
      yield buf;
      buf = "";
    }
  }
  if (buf.trim()) yield buf;
}
function isCompleteStatement(s: string): boolean {
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  let lastSemi = -1;
  for (let p = 0; p < s.length; p++) {
    const ch = s[p];
    if (inStr) {
      if (ch === "\\" && p + 1 < s.length) { p++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === ";" && depth === 0) lastSemi = p;
  }
  return lastSemi === s.length - 1;
}
/** Parse a PARAMETERS block — each line is one param decl with Usage attr. */
function parseAoiParams(body: string[]): L5KAoiParam[] {
  const out: L5KAoiParam[] = [];
  for (const stmt of iterateTagDeclLines(body)) {
    const tag = parseTagDecl(stmt, "AOI_LOCAL", "");
    if (!tag) continue;
    const usage = (() => {
      // parseTagDecl puts non-typed attrs into the `attrs` discard path, so
      // we re-parse the attr-list directly to pull Usage and the other
      // param-specific fields.
      const om = stmt.match(/\((.*)\)/s);
      if (!om) return "Input";
      const a = parseAttrList(om[1]);
      const u = attrValue(a, "Usage");
      return u === "Output" ? "Output" : u === "InOut" ? "InOut" : "Input";
    })() as "Input" | "Output" | "InOut";
    const om = stmt.match(/\((.*)\)/s);
    const attrs = om ? parseAttrList(om[1]) : [];
    out.push({
      name: tag.name,
      type: tag.type,
      arrayDims: tag.arrayDims,
      usage,
      required: attrBool(attrs, "Required"),
      visible: attrBool(attrs, "Visible"),
      description: tag.description,
      externalAccess: tag.externalAccess,
      defaultData: attrValue(attrs, "DefaultData"),
    });
  }
  return out;
}
// ═══════════════════════════════════════════════════════════════════════
// Main extractor — single-pass line scanner with dispatch.
// ═══════════════════════════════════════════════════════════════════════
export function extractL5K(input: string): L5KExtractionResult {
  const result: L5KExtractionResult = {
    isL5K: looksLikeL5K(input),
    ieVer: null,
    controllerName: null,
    stRoutines: [],
    ladderRoutines: [],
    tags: [],
    dataTypes: [],
    modules: [],
    aois: [],
  };
  if (!result.isL5K) return result;
  const lines = input.split(/\r?\n/);
  let parentKind: L5KRoutine["parentKind"] = null;
  let parentName = "";
  const containerStack: Array<{ kind: "AOI" | "PROGRAM" | "TASK"; name: string }> = [];
  // Track the currently-open AOI so PARAMETERS/LOCAL_TAGS attach to it.
  let currentAoi: L5KAoiDef | null = null;
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    // ── Header metadata ────────────────────────────────────────────────
    if (!result.ieVer) {
      const ie = trimmed.match(/^IE_VER\s*:=\s*([0-9.]+)\s*;/);
      if (ie) result.ieVer = ie[1];
    }
    if (!result.controllerName) {
      const ctl = trimmed.match(/^CONTROLLER\s+(\w+)/);
      if (ctl) result.controllerName = ctl[1];
    }
    // ── ADD_ON_INSTRUCTION_DEFINITION (also extracts attrs) ────────────
    const aoiOpen = trimmed.match(/^ADD_ON_INSTRUCTION_DEFINITION\s+(\w+)\s*(\(?)/);
    if (aoiOpen) {
      const name = aoiOpen[1];
      let attrs: { key: string; value: string }[] = [];
      if (aoiOpen[2] === "(") {
        const openCol = raw.indexOf("(");
        const { inner, consumed } = readAttrListFromHere(lines, i, openCol);
        attrs = parseAttrList(inner);
        i += consumed - 1;
      }
      const aoi: L5KAoiDef = {
        name,
        revision: attrString(attrs, "Revision"),
        description: attrString(attrs, "AdditionalHelpText"),
        attrs,
        parameters: [],
        localTags: [],
        sourceStartLine: i + 1,
      };
      result.aois.push(aoi);
      currentAoi = aoi;
      containerStack.push({ kind: "AOI", name });
      parentKind = "AOI";
      parentName = name;
      i++;
      continue;
    }
    if (/^END_ADD_ON_INSTRUCTION_DEFINITION\b/.test(trimmed)) {
      if (containerStack.length > 0) containerStack.pop();
      const top = containerStack[containerStack.length - 1];
      parentKind = top?.kind ?? null;
      parentName = top?.name ?? "";
      currentAoi = null;
      i++;
      continue;
    }
    // ── PROGRAM open/close ─────────────────────────────────────────────
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
    // ── DATATYPE block ─────────────────────────────────────────────────
    const dtOpen = trimmed.match(/^DATATYPE\s+(\w+)\s*(\(?)/);
    if (dtOpen) {
      const name = dtOpen[1];
      let attrs: { key: string; value: string }[] = [];
      if (dtOpen[2] === "(") {
        const openCol = raw.indexOf("(");
        const { inner, consumed } = readAttrListFromHere(lines, i, openCol);
        attrs = parseAttrList(inner);
        i += consumed;
      } else {
        i++;
      }
      const { body, endIdx } = readBlock(lines, i, /^\s*END_DATATYPE\b/);
      i = endIdx + 1;
      result.dataTypes.push({
        name,
        familyType: attrValue(attrs, "FamilyType") ?? "NoFamily",
        members: parseDataTypeMembers(body),
      });
      continue;
    }
    // ── MODULE block ───────────────────────────────────────────────────
    const modOpen = trimmed.match(/^MODULE\s+(\w+)\s*(\(?)/);
    if (modOpen) {
      const name = modOpen[1];
      let attrs: { key: string; value: string }[] = [];
      if (modOpen[2] === "(") {
        const openCol = raw.indexOf("(");
        const { inner, consumed } = readAttrListFromHere(lines, i, openCol);
        attrs = parseAttrList(inner);
        i += consumed;
      } else {
        i++;
      }
      const connections: L5KConnection[] = [];
      // Scan module body for CONNECTION sub-blocks until END_MODULE.
      while (i < lines.length && !/^\s*END_MODULE\b/.test(lines[i])) {
        const subRaw = lines[i];
        const subTrim = subRaw.trim();
        const conOpen = subTrim.match(/^CONNECTION\s+(\w+)\s*(\(?)/);
        if (conOpen) {
          let conAttrs: { key: string; value: string }[] = [];
          if (conOpen[2] === "(") {
            const openCol = subRaw.indexOf("(");
            const { inner, consumed } = readAttrListFromHere(lines, i, openCol);
            conAttrs = parseAttrList(inner);
            i += consumed;
          } else {
            i++;
          }
          // Scan for IO data block names (InputData, OutputData, CommandData, ...)
          const dataBlocks: string[] = [];
          while (i < lines.length && !/^\s*END_CONNECTION\b/.test(lines[i])) {
            const dm = lines[i].trim().match(/^(\w+(?:Data|Status))\s*\(/);
            if (dm) dataBlocks.push(dm[1]);
            i++;
          }
          if (/^\s*END_CONNECTION\b/.test(lines[i])) i++;
          connections.push({ name: conOpen[1], attrs: conAttrs, dataBlocks });
          continue;
        }
        i++;
      }
      if (/^\s*END_MODULE\b/.test(lines[i])) i++;
      result.modules.push({
        name,
        parent: attrString(attrs, "Parent") ?? "",
        catalogNumber: attrString(attrs, "CatalogNumber") ?? "",
        vendor: attrNumber(attrs, "Vendor") ?? 0,
        productType: attrNumber(attrs, "ProductType") ?? 0,
        productCode: attrNumber(attrs, "ProductCode") ?? 0,
        major: attrNumber(attrs, "Major") ?? 0,
        minor: attrNumber(attrs, "Minor") ?? 0,
        slot: attrNumber(attrs, "Slot"),
        safetyEnabled: attrBool(attrs, "SafetyEnabled"),
        attrs,
        connections,
      });
      continue;
    }
    // ── TAG block (controller-scope or program-scope) ──────────────────
    if (trimmed === "TAG") {
      const { body, endIdx } = readBlock(lines, i + 1, /^\s*END_TAG\b/);
      i = endIdx + 1;
      const scopeKind: L5KTag["parentKind"] =
        parentKind === "PROGRAM" ? "PROGRAM" : "CONTROLLER";
      const scopeName = parentKind === "PROGRAM"
        ? parentName
        : (result.controllerName ?? "");
      for (const stmt of iterateTagDeclLines(body)) {
        const t = parseTagDecl(stmt, scopeKind, scopeName);
        if (t) result.tags.push(t);
      }
      continue;
    }
    // ── PARAMETERS / LOCAL_TAGS inside an AOI ──────────────────────────
    if (trimmed === "PARAMETERS" && currentAoi) {
      const { body, endIdx } = readBlock(lines, i + 1, /^\s*END_PARAMETERS\b/);
      i = endIdx + 1;
      currentAoi.parameters = parseAoiParams(body);
      continue;
    }
    if (trimmed === "LOCAL_TAGS" && currentAoi) {
      const { body, endIdx } = readBlock(lines, i + 1, /^\s*END_LOCAL_TAGS\b/);
      i = endIdx + 1;
      for (const stmt of iterateTagDeclLines(body)) {
        const t = parseTagDecl(stmt, "AOI_LOCAL", currentAoi.name);
        if (t) currentAoi.localTags.push(t);
      }
      continue;
    }
    // ── ST_ROUTINE — extract source lines until END_ST_ROUTINE ─────────
    const stOpen = trimmed.match(/^ST_ROUTINE\s+(\w+)/);
    if (stOpen) {
      const routineName = stOpen[1];
      const startLine = i + 1;
      const stLines: string[] = [];
      i++;
      while (i < lines.length) {
        const r = lines[i];
        if (/^\s*END_ST_ROUTINE\b/.test(r)) { i++; break; }
        const m = r.match(/^\s*'(.*)$/);
        if (m) stLines.push(m[1]);
        else if (r.trim() === "") stLines.push("");
        else stLines.push(r.trim());
        i++;
      }
      result.stRoutines.push({
        name: routineName,
        parentKind, parentName,
        source: stLines.join("\n"),
        sourceStartLine: startLine,
      });
      continue;
    }
    // ── Ladder ROUTINE — record and extract every rung ─────────────────
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
        if (/^\s*END_ROUTINE\b/.test(r)) { i++; break; }
        const rcMatch = r.match(/^\s*RC:\s*(.*)$/);
        if (rcMatch) {
          let payload = rcMatch[1];
          while (!payload.trimEnd().endsWith(";")) {
            i++;
            if (i >= lines.length) break;
            payload += " " + lines[i].trim();
          }
          payload = payload.replace(/;\s*$/, "");
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
        const nMatch = r.match(/^\s*N:\s*(.*)$/);
        if (nMatch) {
          let payload = nMatch[1];
          while (!payload.trimEnd().endsWith(";")) {
            i++;
            if (i >= lines.length) break;
            payload += " " + lines[i].trim();
          }
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
        i++;
      }
      result.ladderRoutines.push({
        name: routineName,
        parentKind, parentName,
        sourceStartLine: startLine,
        ruleCount: rungs.length,
        rungs,
      });
      continue;
    }
    // Default: advance
    i++;
  }
  return result;
}
// ═══════════════════════════════════════════════════════════════════════
// Joiner (kept for backward compat with translate.ts older path)
// ═══════════════════════════════════════════════════════════════════════
export interface JoinedResult {
  source: string;
  ladderTranslated: number;
  ladderRungs: number;
  ladderFailedRungs: number;
  manualPortInstructions: Set<string>;
  ladderWarnings: string[];
}
export function joinExtractedRoutines(result: L5KExtractionResult): string {
  const parts: string[] = [];
  for (const r of result.stRoutines) {
    parts.push(`(* L5K ST_ROUTINE: ${r.parentKind} ${r.parentName} / ${r.name} (source line ${r.sourceStartLine}) *)`);
    parts.push(r.source);
    parts.push("");
  }
  return parts.join("\n");
}
