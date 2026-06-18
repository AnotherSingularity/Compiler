/**
 * Emit IEC 61131-3 FUNCTION_BLOCK declarations from extracted L5K AOIs.
 *
 * AB Add-On Instructions (AOIs) are roughly equivalent to IEC function
 * blocks. Each AOI has:
 *   - PARAMETERS (Input / Output / InOut)
 *   - LOCAL_TAGS (internal state — maps to VAR section)
 *   - One or more routines (typically just "Logic")
 *
 * This emitter produces one FUNCTION_BLOCK per AOI:
 *
 *   FUNCTION_BLOCK FB_AoiName
 *   VAR_INPUT
 *     ParamA : Bit;
 *     ParamB : DInt;
 *   END_VAR
 *   VAR_OUTPUT
 *     ParamC : Bit;
 *   END_VAR
 *   VAR_IN_OUT
 *     ParamD : MyUdt;
 *   END_VAR
 *   VAR
 *     LocalA : Bit;
 *     LocalB : Timer;
 *   END_VAR
 *
 *   (* Body from ROUTINE Logic — translated ST *)
 *   <body>
 *
 *   END_FUNCTION_BLOCK
 *
 * Routines other than Logic (Prescan, Postscan, EnableInFalse) emit as
 * commented-out scaffolds so the user can port them manually. These
 * special routines run in IEC contexts very differently from AB's scan
 * model and don't translate automatically.
 */
import type { L5KAoiDef, L5KAoiParam, L5KRoutine, L5KLadderRoutine, L5KTag } from "./l5k_extract";
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
function renderArrayType(base: string, arrayDims: number[]): string {
  const t = mapType(base);
  if (arrayDims.length === 0) return t;
  return `Array (${arrayDims.map(n => `0..${n - 1}`).join(", ")}) of ${t}`;
}
function renderParam(p: L5KAoiParam): string {
  const t = renderArrayType(p.type, p.arrayDims);
  const desc = p.description ? `  (* ${p.description.replace(/\*\)/g, "* )")} *)` : "";
  return `  ${p.name} : ${t};${desc}`;
}
function renderLocal(t: L5KTag): string {
  const tp = renderArrayType(t.type, t.arrayDims);
  const desc = t.description ? `  (* ${t.description.replace(/\*\)/g, "* )")} *)` : "";
  return `  ${t.name} : ${tp};${desc}`;
}
/**
 * Render the VAR sections of a FUNCTION_BLOCK. Empty sections are omitted.
 * EnableIn / EnableOut are IEC system-defined and are skipped here (GX
 * Works handles them implicitly).
 */
function renderVarSections(params: L5KAoiParam[], locals: L5KTag[]): string {
  const lines: string[] = [];
  const skip = new Set(["EnableIn", "EnableOut"]);
  const inputs = params.filter(p => p.usage === "Input" && !skip.has(p.name));
  const outputs = params.filter(p => p.usage === "Output" && !skip.has(p.name));
  const inouts = params.filter(p => p.usage === "InOut");
  if (inputs.length > 0) {
    lines.push("VAR_INPUT");
    for (const p of inputs) lines.push(renderParam(p));
    lines.push("END_VAR");
  }
  if (outputs.length > 0) {
    lines.push("VAR_OUTPUT");
    for (const p of outputs) lines.push(renderParam(p));
    lines.push("END_VAR");
  }
  if (inouts.length > 0) {
    lines.push("VAR_IN_OUT");
    for (const p of inouts) lines.push(renderParam(p));
    lines.push("END_VAR");
  }
  if (locals.length > 0) {
    lines.push("VAR");
    for (const t of locals) lines.push(renderLocal(t));
    lines.push("END_VAR");
  }
  return lines.join("\n");
}
/**
 * Emit one FUNCTION_BLOCK per AOI. Body is taken from the routines passed
 * in `routineBodies` — keyed by routine name (typically "Logic").
 *
 * `routineBodies` is precomputed by the caller because emitting routine
 * bodies requires the ladder and ST emitters which we don't import here
 * (to keep this module dependency-free aside from extract types).
 */
export function emitAoiAsFb(
  aoi: L5KAoiDef,
  routineBodies: Map<string, string>,
): string {
  const out: string[] = [];
  if (aoi.description) {
    out.push(`(* ${aoi.description.replace(/\*\)/g, "* )")} *)`);
  }
  if (aoi.revision) {
    out.push(`(* AOI revision: ${aoi.revision} *)`);
  }
  out.push(`FUNCTION_BLOCK FB_${aoi.name}`);
  const vars = renderVarSections(aoi.parameters, aoi.localTags);
  if (vars) out.push(vars);
  out.push("");
  const logic = routineBodies.get("Logic");
  if (logic && logic.trim()) {
    out.push("(* Body — translated from AOI 'Logic' routine *)");
    out.push(logic.trim());
  } else {
    out.push("(* AOI has no Logic routine, or it could not be translated *)");
  }
  // Special routines as commented scaffolds.
  for (const [name, body] of routineBodies) {
    if (name === "Logic") continue;
    out.push("");
    out.push(`(* ── AOI routine '${name}' — port manually ──`);
    out.push(body.trim().split("\n").map(l => `   ${l}`).join("\n"));
    out.push("*)");
  }
  out.push("");
  out.push(`END_FUNCTION_BLOCK`);
  return out.join("\n");
}
/**
 * Group routines (ST and ladder) by AOI parent name so callers can build
 * `routineBodies` maps for each AOI. Routines not parented to an AOI are
 * dropped here (the caller already emits those in the main program output).
 */
export function groupRoutinesByAoi(
  stRoutines: L5KRoutine[],
  ladderRoutines: L5KLadderRoutine[],
): Map<string, { st: L5KRoutine[]; ladder: L5KLadderRoutine[] }> {
  const out = new Map<string, { st: L5KRoutine[]; ladder: L5KLadderRoutine[] }>();
  for (const r of stRoutines) {
    if (r.parentKind !== "AOI") continue;
    const bucket = out.get(r.parentName) ?? { st: [], ladder: [] };
    bucket.st.push(r);
    out.set(r.parentName, bucket);
  }
  for (const r of ladderRoutines) {
    if (r.parentKind !== "AOI") continue;
    const bucket = out.get(r.parentName) ?? { st: [], ladder: [] };
    bucket.ladder.push(r);
    out.set(r.parentName, bucket);
  }
  return out;
}
