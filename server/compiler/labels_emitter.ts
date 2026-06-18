/**
 * Emit a GX Works global-labels CSV from extracted L5K tags.
 *
 * Format target: Mitsubishi GX Works2/3 global label import.
 * Columns: Class,Label,DataType,Constant,Comment
 *   Class:    VAR_GLOBAL | VAR_GLOBAL_RETAIN | VAR
 *   Label:    tag identifier (sanitized to Mitsubishi rules — alnum + underscore)
 *   DataType: Mitsubishi-native type (Bit, Word, DWord, Int, DInt, Real, ...)
 *             or UDT name. Arrays expand to "Array (0..N-1) of <type>".
 *   Constant: blank — auto-assigned by GX Works
 *   Comment:  Description attribute, plus indexed COMMENT[N] entries
 *             flattened with "[N]: text" prefix for traceability.
 *
 * Type mapping AB → MEL:
 *   BOOL    → Bit
 *   SINT    → Word           (Mitsubishi has no native 8-bit; use Word)
 *   INT     → Int
 *   DINT    → DInt
 *   LINT    → LInt
 *   USINT   → Word
 *   UINT    → UInt
 *   UDINT   → UDInt
 *   ULINT   → ULInt
 *   REAL    → Real           (32-bit float)
 *   LREAL   → LReal          (64-bit float)
 *   STRING  → String          (length must be set per Mitsubishi conventions)
 *   TIMER   → TIMER           (FB type — declare via FB instance)
 *   COUNTER → COUNTER         (FB type)
 *   <UDT>   → <UDT>           (must be defined as Structured Data Type first)
 */
import type { L5KTag, L5KDataType } from "./l5k_extract";
const AB_TO_MEL_TYPE: Record<string, string> = {
  BOOL: "Bit",
  SINT: "Word",
  INT: "Int",
  DINT: "DInt",
  LINT: "LInt",
  USINT: "Word",
  UINT: "UInt",
  UDINT: "UDInt",
  ULINT: "ULInt",
  REAL: "Real",
  LREAL: "LReal",
  STRING: "String(82)",
  TIMER: "TIMER",
  COUNTER: "COUNTER",
};
function mapType(abType: string): string {
  return AB_TO_MEL_TYPE[abType.toUpperCase()] ?? abType;
}
/** Render a Mitsubishi-compatible data type string for a tag. */
function renderType(t: L5KTag): string {
  const base = mapType(t.type);
  if (t.arrayDims.length === 0) return base;
  // AB arrays are 0-indexed contiguous. Mitsubishi syntax: Array (0..N-1) of T
  const dimStr = t.arrayDims
    .map(n => `0..${n - 1}`)
    .join(", ");
  return `Array (${dimStr}) of ${base}`;
}
/**
 * CSV-quote a field. Wraps in double quotes if the value contains comma,
 * newline, or quote; doubles embedded quotes.
 */
function csvField(v: string): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
/**
 * Build a "comment" cell that combines the tag's description with its
 * indexed COMMENT[N] entries. Indexed entries are joined with " | " to
 * preserve traceability (the originals describe array elements).
 */
function buildComment(t: L5KTag): string {
  const parts: string[] = [];
  if (t.description) parts.push(t.description);
  if (t.comments.length > 0) {
    const cm = [...t.comments]
      .sort((a, b) => a.index - b.index)
      .map(c => `[${c.index}]: ${c.text}`)
      .join(" | ");
    parts.push(cm);
  }
  return parts.join(" — ");
}
/**
 * Classify a tag's Mitsubishi Class. The L5K Class attribute is "Standard"
 * or "Safety"; neither maps directly. We map all non-AOI-local tags to
 * VAR_GLOBAL. Safety-tagged ones get a "(SAFETY)" prefix in the comment
 * so the user can sort them into a safety label table manually.
 */
function classOf(t: L5KTag): string {
  if (t.parentKind === "AOI_LOCAL") return "VAR";
  return "VAR_GLOBAL";
}
export function emitLabelsCsv(
  tags: L5KTag[],
  _dataTypes: L5KDataType[], // currently unused; could emit STRUCT rows when format supports
): string {
  const rows: string[] = [];
  rows.push("Class,Label,DataType,Constant,Comment");
  for (const t of tags) {
    // Skip AOI local tags — they belong inside FB VAR blocks, not the
    // global label table.
    if (t.parentKind === "AOI_LOCAL") continue;
    const safetyPrefix = t.className === "Safety" ? "(SAFETY) " : "";
    const cls = classOf(t);
    const label = t.name;
    const dtype = renderType(t);
    const comment = safetyPrefix + buildComment(t);
    rows.push([cls, label, dtype, "", comment].map(csvField).join(","));
  }
  return rows.join("\r\n");
}
/**
 * Emit a separate human-readable summary of UDTs (Structured Data Types).
 * GX Works can't ingest UDT definitions through the same CSV as labels;
 * UDTs must be created via the project tree or imported via the .gxr
 * structured-type format. For now this is a documentation aid the user
 * uses to recreate the structures manually.
 *
 * Output is plain text, one UDT per section:
 *
 *   STRUCT MyUdt
 *     field_name : Type;        // optional description
 *     BIT bit_name : parent_field.N;
 *   END_STRUCT
 */
export function emitUdtSummary(dataTypes: L5KDataType[]): string {
  const out: string[] = [];
  out.push("// Structured Data Types (UDTs) extracted from L5K.");
  out.push("// Create these in GX Works as Structured Data Types BEFORE importing labels.csv.");
  out.push("// Lines starting with BIT denote bit-fields packed into a parent SINT/INT/DINT.");
  out.push("");
  for (const dt of dataTypes) {
    out.push(`STRUCT ${dt.name}  (* FamilyType := ${dt.familyType} *)`);
    for (const m of dt.members) {
      if (m.kind === "field") {
        const t = mapType(m.type);
        const arr = m.arrayDims.length > 0
          ? ` [${m.arrayDims.map(n => `0..${n - 1}`).join(", ")}]`
          : "";
        const hidden = m.hidden ? "  (* hidden — backs bit-fields *)" : "";
        const desc = m.description ? `  // ${m.description}` : "";
        out.push(`  ${m.name} : ${t}${arr};${hidden}${desc}`);
      } else {
        // BIT decls are commented-out style; user binds them via the parent
        // field's bit access syntax (e.g., parent.0).
        const desc = m.description ? `  // ${m.description}` : "";
        out.push(`  (* BIT ${m.name} := ${m.parentField}.${m.bitOffset} *)${desc}`);
      }
    }
    out.push("END_STRUCT");
    out.push("");
  }
  return out.join("\n");
}
