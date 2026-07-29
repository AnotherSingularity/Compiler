/**
 * Ladder → ST Emitter
 *
 * Takes a RungAst produced by ladder_parser.ts and emits Structured Text
 * that preserves the rung's runtime semantics.
 *
 * Translation strategy:
 *   1. Walk the rung tree. Collect input contacts and comparisons into a
 *      single boolean "rung condition" expression. Series = AND, branch = OR.
 *   2. Collect outputs (coils, actions, timers, control flow) in order.
 *   3. Emit: `IF (rung_condition) THEN <outputs> END_IF;`
 *   4. For unconditional outputs (CPT outside any condition, JSR, NOP),
 *      emit without the IF wrapper.
 *
 * Special handling:
 *   - OTE(tag): combinational — emit `tag := rung_condition;` (not gated)
 *     because OTE drives FALSE when the rung is false, not just unchanged.
 *   - OTL(tag): latch — `IF cond THEN tag := TRUE; END_IF;`
 *   - OTU(tag): unlatch — `IF cond THEN tag := FALSE; END_IF;`
 *   - ONS(state): one-shot — needs a state variable, emit a TODO comment
 *   - TON(timer): timer enable controlled by rung condition
 *   - JSR(name, ...): subroutine call — `IF cond THEN name(); END_IF;`
 *   - AFI: always false — entire rung disabled (emit a comment)
 *   - NOP: no operation (emit nothing, or a comment for traceability)
 *   - MCR: master control reset — complex, emit MANUAL_PORT
 */
import {
  RungAst,
  RungNode,
  InstructionNode,
  BranchNode,
  SeriesNode,
  instructionRole,
  parseRung,
} from "./ladder_parser";
export interface EmitOptions {
  /** Prepend a comment with the original rung source. Default true. */
  includeProvenance?: boolean;
  /** Indentation prefix for emitted ST lines. Default "". */
  indent?: string;
}
export interface EmitResult {
  /** Emitted ST source. May be empty for NOP-only rungs. */
  st: string;
  /** Instructions encountered that don't have a translation rule yet. */
  manualPorts: string[];
  /** Soft warnings (e.g., one-shots that need state variables). */
  warnings: string[];
}
/**
 * Top-level: emit ST for one rung.
 */
export function emitRung(ast: RungAst, opts: EmitOptions = {}): EmitResult {
  const { includeProvenance = true, indent = "" } = opts;
  const ctx: EmitCtx = { manualPorts: [], warnings: [] };
  // Split the rung into "conditioning instructions" and "outputs".
  // We walk the root series; everything up to the first output is conditioning;
  // outputs accumulate the rest. Branches are treated as conditioning if every
  // path contains only conditioning instructions; otherwise they're outputs.
  const { conditionExpr, outputs } = splitRung(ast.root, ctx);
  const lines: string[] = [];
  if (includeProvenance) {
    // Keep provenance compact; original is single line
    const trimmed = ast.source.trim().replace(/\s+/g, " ");
    if (trimmed.length > 0) {
      lines.push(`${indent}// [AB→MEL] rung: ${truncate(trimmed, 120)}`);
    }
  }
  // If no outputs at all, just emit the conditioning as a no-op block
  // (preserves intent for review).
  if (outputs.length === 0) {
    if (conditionExpr && conditionExpr !== "TRUE") {
      lines.push(`${indent}// (* rung condition with no outputs: ${conditionExpr} *)`);
    }
    return { st: lines.join("\n"), manualPorts: ctx.manualPorts, warnings: ctx.warnings };
  }
  // Emit each output. Outputs that need to be gated on rung condition get
  // wrapped in IF; outputs that are unconditional (NOP, LBL, etc.) don't.
  const cond = conditionExpr || "TRUE";
  // Delegate to emitOutputs which handles self-gated/wrapper-gated split,
  // recurses into Branches, and combines path conditions correctly.
  const emitted = emitOutputs(outputs, cond, ctx, indent);
  for (const line of emitted) lines.push(line);
  return {
    st: lines.join("\n"),
    manualPorts: ctx.manualPorts,
    warnings: ctx.warnings,
  };
}
// ════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════
interface EmitCtx {
  manualPorts: string[];
  warnings: string[];
}
function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 3) + "...";
}
/**
 * Convert a tag reference (which may contain `.` `[` `]`) into a valid ST
 * identifier. Used when synthesizing state variables (one-shot edges, etc.)
 * from AB tag references.
 */
function sanitizeIdent(s: string): string {
  return s
    .replace(/\[/g, "_")
    .replace(/\]/g, "")
    .replace(/\./g, "_")
    .replace(/[^A-Za-z0-9_]/g, "_");
}
/**
 * Split a rung's root series into:
 *   - conditionExpr: the boolean expression representing the rung's enable
 *   - outputs: the instructions that should run when the rung is true
 *
 * In AB ladder, conditioning (contacts, compares) and outputs (coils, actions)
 * can be interleaved in source order. Contacts wherever they sit contribute
 * to the rung's main condition; outputs execute when the condition holds.
 * Output-position branches are parallel sub-rungs (each path has its own
 * sub-condition + outputs).
 */
function splitRung(
  root: SeriesNode,
  ctx: EmitCtx,
): { conditionExpr: string; outputs: RungNode[] } {
  const conditioning: RungNode[] = [];
  const outputs: RungNode[] = [];
  for (const el of root.elements) {
    if (isConditioning(el)) {
      conditioning.push(el);
    } else {
      outputs.push(el);
    }
  }
  const conditionExpr = conditioning.length === 0
    ? ""
    : conditioning.map(c => emitConditionPart(c, ctx)).join(" AND ");
  return { conditionExpr, outputs };
}
function isConditioning(node: RungNode): boolean {
  if (node.kind === "Instruction") {
    const role = instructionRole(node.name);
    return role === "input_contact" || role === "compare";
  }
  if (node.kind === "Branch") {
    // A branch is conditioning iff every path's elements are all conditioning
    return node.paths.every(p => p.elements.every(isConditioning));
  }
  if (node.kind === "Series") {
    return node.elements.every(isConditioning);
  }
  return false;
}
/** Emit a conditioning element as a boolean expression. */
function emitConditionPart(node: RungNode, ctx: EmitCtx): string {
  if (node.kind === "Instruction") {
    return emitConditionInstruction(node, ctx);
  }
  if (node.kind === "Branch") {
    // Each path is a conjunction; the branch is the disjunction of paths.
    const pathExprs = node.paths.map(p => {
      const parts = p.elements.map(e => emitConditionPart(e, ctx));
      if (parts.length === 0) return "TRUE";
      if (parts.length === 1) return parts[0];
      return parts.join(" AND ");
    });
    if (pathExprs.length === 1) return pathExprs[0];
    return "(" + pathExprs.join(" OR ") + ")";
  }
  if (node.kind === "Series") {
    const parts = node.elements.map(e => emitConditionPart(e, ctx));
    if (parts.length === 1) return parts[0];
    return parts.join(" AND ");
  }
  return "TRUE";
}
function emitConditionInstruction(node: InstructionNode, ctx: EmitCtx): string {
  const a = node.args;
  switch (node.name) {
    // Boolean contacts
    case "XIC": return a[0] ?? "FALSE";
    case "XIO": return `NOT ${a[0] ?? "FALSE"}`;
    case "AFI": return "FALSE";
    case "ONS": {
      // ONS uses a storage bit to detect one-shot. Best-effort translation:
      // treat as the storage bit, with a warning that proper one-shot needs
      // a rising-edge detection variable in MEL.
      const safe = sanitizeIdent(a[0] ?? "ons");
      ctx.warnings.push(`ONS(${a[0]}) needs explicit rising-edge state variable in MEL`);
      return `${safe}_ONS_pending`;
    }
    case "OSR":
    case "OSF": {
      const safe = sanitizeIdent(a[0] ?? "edge");
      ctx.warnings.push(`${node.name}(${a[0]}) — edge detection requires state machine in MEL`);
      return `${safe}_${node.name}_edge`;
    }
    // Comparisons — emit AB syntax directly
    case "EQU": return `(${a[0]} = ${a[1]})`;
    case "NEQ": return `(${a[0]} <> ${a[1]})`;
    case "LES": return `(${a[0]} < ${a[1]})`;
    case "GRT": return `(${a[0]} > ${a[1]})`;
    case "LEQ": return `(${a[0]} <= ${a[1]})`;
    case "GEQ": return `(${a[0]} >= ${a[1]})`;
    case "CMP": return `(${a[0]})`;  // CMP(expr) returns the expression's bool
    case "MEQ": return `((${a[0]} AND ${a[1]}) = ${a[2]})`;
    case "LIM": return `((${a[0]} <= ${a[1]}) AND (${a[1]} <= ${a[2]}))`;
    default: {
      ctx.manualPorts.push(node.name);
      return `/* MANUAL_PORT ${node.name}(${a.join(",")}) */ FALSE`;
    }
  }
}
/**
 * Determine whether the outputs need to be wrapped in IF(cond) THEN ... END_IF.
 * If every output already includes the rung condition in its own emit (OTE is
 * combinational, latches are self-wrapped), we don't need an outer IF.
 *
 * Decision: if outputs contain anything besides OTE (which is combinational),
 * wrap them all in IF(cond). OTE inside the wrapper still works correctly
 * because we emit `tag := TRUE` inside the IF, but we lose the FALSE-drive
 * semantics. So we special-case: if OTE is present alongside other outputs,
 * we emit OTE *outside* the wrapper, and the rest inside.
 *
 * Simpler approach: always wrap; emit OTE as `tag := rung_condition` which
 * is correctly combinational regardless of wrapper. Implemented in emitOutput.
 */
/**
 * Returns true if the output instruction's emission already encodes the rung
 * condition itself, producing correct behavior whether cond is true or false.
 * Self-gated outputs are emitted OUTSIDE any IF wrapper.
 *
 *   OTE         → `Y := cond;` (drives FALSE when cond is FALSE — correct)
 *   TON/TOF/RTO → `T(IN := cond, ...);` (IEC FB tracks IN edges, must run every scan)
 *   CTU/CTD     → `C(CU := cond, ...);` (same — IEC counter FB)
 *
 * Everything else (OTL, OTU, MOV, ADD, JSR, CPT, COP, FLL, etc.) is a state
 * change that should only fire when cond is true, so it goes inside the IF
 * wrapper.
 */
function isSelfGated(node: RungNode): boolean {
  if (node.kind !== "Instruction") return false;
  switch (node.name) {
    case "OTE":
    case "TON":
    case "TOF":
    case "RTO":
    case "CTU":
    case "CTD":
      return true;
    default:
      return false;
  }
}
/**
 * Emit a list of outputs given a rung condition. Returns the ordered output
 * lines (already indented). Used by both emitRung at the top level and by
 * the Branch case in emitOutput for per-path emission.
 *
 * Partitions outputs into three categories:
 *   1. Self-gated instructions (OTE, TON, etc.) — emit unconditionally.
 *   2. Branches — recurse, combining outer cond with each path's sub-cond.
 *   3. Wrapper-gated instructions — emit inside `IF (cond) THEN ... END_IF`.
 *
 * The split is critical for correctness: timer FBs must run every scan to
 * track edges, OTE must drive FALSE when cond is FALSE, but state-change
 * outputs (latches, MOV, JSR) must only fire when cond is true.
 */
function emitOutputs(
  outputs: RungNode[],
  cond: string,
  ctx: EmitCtx,
  indent: string,
): string[] {
  const lines: string[] = [];
  const selfGated: RungNode[] = [];
  const branches: RungNode[] = [];
  const wrapperGated: RungNode[] = [];
  for (const out of outputs) {
    if (out.kind === "Branch") branches.push(out);
    else if (isSelfGated(out)) selfGated.push(out);
    else wrapperGated.push(out);
  }
  // 1. Self-gated outputs — emit each unconditionally with the rung cond.
  for (const out of selfGated) {
    const stmt = emitOutput(out, cond, ctx, indent);
    if (stmt) {
      for (const line of stmt.split("\n")) lines.push(`${indent}${line}`);
    }
  }
  // 2. Branches — each path becomes a sub-emission with combined cond.
  for (const branch of branches) {
    if (branch.kind !== "Branch") continue;
    for (const path of branch.paths) {
      const sub = splitRung(path, ctx);
      const combined = sub.conditionExpr
        ? (cond === "TRUE" ? sub.conditionExpr : `(${cond}) AND (${sub.conditionExpr})`)
        : cond;
      if (sub.outputs.length === 0) continue;
      const sublines = emitOutputs(sub.outputs, combined, ctx, indent);
      for (const line of sublines) lines.push(line);
    }
  }
  // 3. Wrapper-gated outputs — group inside `IF (cond) THEN ... END_IF`.
  if (wrapperGated.length > 0) {
    const wrapperStmts: string[] = [];
    for (const out of wrapperGated) {
      const stmt = emitOutput(out, cond, ctx, indent);
      if (stmt) wrapperStmts.push(stmt);
    }
    if (cond !== "TRUE") {
      lines.push(`${indent}IF (${cond}) THEN`);
      for (const stmt of wrapperStmts) {
        for (const line of stmt.split("\n")) {
          lines.push(`${indent}  ${line}`);
        }
      }
      lines.push(`${indent}END_IF;`);
    } else {
      for (const stmt of wrapperStmts) {
        for (const line of stmt.split("\n")) lines.push(`${indent}${line}`);
      }
    }
  }
  return lines;
}
/** Emit a single output instruction as one or more ST statements. */
function emitOutput(
  node: RungNode,
  cond: string,
  ctx: EmitCtx,
  indent: string,
): string {
  // Branches in output position: each path is its own sub-emission with
  // combined cond (outer cond AND path's own conditioning). emitOutputs
  // applies the self-gated/wrapper-gated split per path — so a TON inside
  // a branch path still emits unconditionally, an OTL stays wrapped, etc.
  // This is recursive: the per-path emitOutputs may itself encounter more
  // Branches and recurse further.
  if (node.kind === "Branch") {
    const parts: string[] = [];
    for (const path of node.paths) {
      const sub = splitRung(path, ctx);
      const combinedCond = sub.conditionExpr
        ? (cond === "TRUE" ? sub.conditionExpr : `(${cond}) AND (${sub.conditionExpr})`)
        : cond;
      if (sub.outputs.length === 0) continue;
      const sublines = emitOutputs(sub.outputs, combinedCond, ctx, "");
      if (sublines.length === 0) continue;
      parts.push(sublines.join("\n"));
    }
    return parts.join("\n");
  }
  if (node.kind !== "Instruction") return "";
  const a = node.args;
  switch (node.name) {
    // ─── Output coils ─────────────────────────────────────────────────
    case "OTE":
      // Combinational: tag drives the rung condition.
      //   XIC(X) OTE(Y) → Y := X;
      //   OTE(Y)        → Y := TRUE;
      // OTE inside an IF wrapper is semantically wrong (loses FALSE-drive on
      // rung-false). emitRung avoids the wrapper when all outputs are OTE.
      // Mixed rungs (OTE+OTL+MOV) still hit the wrapper; that's a known
      // limitation tracked for v2 (see splitRung notes).
      return `${a[0]} := ${cond};`;
    case "OTL":
      return `${a[0]} := TRUE;`;
    case "OTU":
      return `${a[0]} := FALSE;`;
    // ─── Move / arithmetic ────────────────────────────────────────────
    case "MOV":  return `${a[1]} := ${a[0]};`;
    case "CLR":  return `${a[0]} := 0;`;
    case "ADD":  return `${a[2]} := ${a[0]} + ${a[1]};`;
    case "SUB":  return `${a[2]} := ${a[0]} - ${a[1]};`;
    case "MUL":  return `${a[2]} := ${a[0]} * ${a[1]};`;
    case "DIV":  return `${a[2]} := ${a[0]} / ${a[1]};`;
    case "MOD":  return `${a[2]} := ${a[0]} MOD ${a[1]};`;
    case "ABS":  return `${a[1]} := ABS(${a[0]});`;
    case "SQR":  return `${a[1]} := SQRT(${a[0]});`;
    case "NEG":  return `${a[1]} := -${a[0]};`;
    // CPT — compute: destination := expression
    case "CPT":  return `${a[0]} := ${a[1]};`;
    // ─── File / array operations ──────────────────────────────────────
    case "COP":
      // COP(source, dest, count) — copy `count` elements
      return `MEMCPY(${a[1]}, ${a[0]}, ${a[2]}); (* COP — confirm MEL block-move primitive *)`;
    case "FLL":
      return `MEMSET(${a[1]}, ${a[0]}, ${a[2]}); (* FLL — confirm MEL fill primitive *)`;
    // ─── Timers / counters ────────────────────────────────────────────
    // IEC 61131-3 / GX Works ST function-block call syntax.
    // PT (preset) is left blank with a TODO marker — AB timers store .PRE as
    // a DINT (milliseconds), but MEL ST requires a TIME literal (T#5s etc.).
    // The migration must map .PRE values explicitly, since the format is
    // not lexically convertible. The accumulator is tracked by the FB
    // automatically.
    //
    // KNOWN LIMITATION: IEC FBs must be called every scan to track IN edges
    // correctly. If this timer is inside the rung's IF wrapper (which
    // happens when the rung also has non-combinational outputs), it will
    // not be called when cond is false, breaking the IN-falling-edge
    // detection. v2 should hoist timer/counter FB calls outside the wrapper.
    case "TON":
    case "TOF":
    case "RTO": {
      const tname = a[0];
      return `${tname}(IN := ${cond}, PT := T#0ms); (* TODO: set PT from original ${tname}.PRE *)`;
    }
    case "CTU": {
      const cname = a[0];
      return `${cname}(CU := ${cname}_CU_edge AND ${cond}, R := FALSE, PV := 0); (* TODO: set PV from original ${cname}.PRE and wire R from RES *)`;
    }
    case "CTD": {
      const cname = a[0];
      return `${cname}(CD := ${cname}_CD_edge AND ${cond}, LD := FALSE, PV := 0); (* TODO: set PV from original ${cname}.PRE and wire LD from RES *)`;
    }
    case "RES":
      return `${a[0]}.Reset := TRUE; (* RES — verify Mitsubishi reset method for this instance type *)`;
    // ─── Control flow ─────────────────────────────────────────────────
    case "JSR": {
      // JSR(routine_name, param_count, [params...])
      const routine = a[0];
      const params = a.slice(2);  // skip name + count
      return `${routine}(${params.join(", ")});`;
    }
    case "JMP": {
      ctx.warnings.push(`JMP(${a[0]}) — Mitsubishi labels work but verify scope semantics`);
      return `// JMP to label ${a[0]} — MEL ladder labels: GOTO ${a[0]}; (verify)`;
    }
    case "LBL":
      return `// LBL ${a[0]}:`;
    case "RET":
      return `RETURN;`;
    case "NOP":
      return "";  // no-op emits nothing
    case "MCR":
      ctx.manualPorts.push("MCR");
      return `// MANUAL_PORT: MCR (master control reset) — needs explicit MEL implementation`;
    case "AFI":
      return "// AFI — rung always false; outputs not driven";
    case "TND":
      return `RETURN; (* TND — temporary end of scan *)`;
    case "SBR":
      return `// SBR ${a.join(", ")} — subroutine parameter declaration`;
    // ─── System ───────────────────────────────────────────────────────
    case "GSV":
    case "SSV":
      ctx.manualPorts.push(node.name);
      return `// MANUAL_PORT: ${node.name}(${a.join(", ")}) — system value access differs between platforms`;
    // ─── Strings ──────────────────────────────────────────────────────
    case "CONCAT": return `${a[2]} := CONCAT(${a[0]}, ${a[1]});`;
    case "INSERT": return `${a[3]} := INSERT(${a[0]}, ${a[1]}, ${a[2]});`;
    case "DELETE": return `${a[3]} := DELETE(${a[0]}, ${a[1]}, ${a[2]});`;
    case "MID":    return `${a[3]} := MID(${a[0]}, ${a[1]}, ${a[2]});`;
    case "FIND":   return `${a[3]} := FIND(${a[0]}, ${a[1]}, ${a[2]});`;
    // ─── Comparisons used as outputs (unusual but legal in AB) ────────
    case "EQU": case "NEQ": case "LES": case "GRT":
    case "LEQ": case "GEQ": case "CMP": case "MEQ": case "LIM":
      return `// ${node.name}(${a.join(", ")}) — comparison used as output; result discarded`;
    // ─── AOI invocation / unsupported fallback ────────────────────────
    default: {
      const role = instructionRole(node.name);
      if (role === "unsupported") {
        // Known AB builtin with no MEL equivalent. Emit as a block comment
        // preserving the original call form — safe regardless of arg content.
        ctx.manualPorts.push(node.name);
        const safeArgs = a.join(", ").replace(/\*\)/g, "*\\)");
        return `(* MANUAL_PORT: ${node.name}(${safeArgs}) — Rockwell-specific instruction, needs manual port *)`;
      }
      if (role === "aoi_call") {
        // User-defined AOI invocation. Emit as FB call — assume args are
        // valid ST identifiers (which they will be for legitimate AOI calls).
        return `${node.name}(${a.join(", ")});`;
      }
      ctx.manualPorts.push(node.name);
      const safeArgs = a.join(", ").replace(/\*\)/g, "*\\)");
      return `(* MANUAL_PORT: ${node.name}(${safeArgs}) — instruction not in v1 set *)`;
    }
  }
}
// ════════════════════════════════════════════════════════════════════════
// Multi-rung routine emission
// ════════════════════════════════════════════════════════════════════════
export interface RungInput {
  /** 1-indexed rung number (for diagnostics) */
  number: number;
  /** Rung comment text (RC), if any */
  comment: string | null;
  /** Rung logic source text (N) */
  source: string;
}
export interface EmitRoutineResult {
  st: string;
  rungCount: number;
  failedRungCount: number;
  manualPortInstructions: string[];   // unique instruction names that became MANUAL_PORT
  warnings: string[];
}
/**
 * Emit ST for an entire ladder routine. Parses each rung individually and
 * concatenates the output, with comments preserving original structure.
 */
export function emitLadderRoutine(rungs: RungInput[], indent = ""): EmitRoutineResult {
  // parseRung is imported statically (see top of file). A lazy require() here
  // breaks under ESM (the production bundle is `--format=esm`) and under vitest.
  const lines: string[] = [];
  const manualPortSet = new Set<string>();
  const warnings: string[] = [];
  let failedRungCount = 0;
  for (const rung of rungs) {
    if (rung.comment) {
      // Each line of the comment becomes a (* *) block
      const c = rung.comment.replace(/\*\)/g, "*\\)");
      lines.push(`${indent}(* ── Rung ${rung.number}: ${truncate(c, 200)} ── *)`);
    } else {
      lines.push(`${indent}(* ── Rung ${rung.number} ── *)`);
    }
    const { ast, error } = parseRung(rung.source);
    if (!ast) {
      lines.push(`${indent}// MANUAL_PORT: rung ${rung.number} failed to parse — ${error}`);
      lines.push(`${indent}// Original: ${truncate(rung.source, 200)}`);
      failedRungCount++;
      manualPortSet.add(`<parse-failed:${rung.number}>`);
      lines.push("");
      continue;
    }
    const result = emitRung(ast, { includeProvenance: false, indent });
    if (result.st) lines.push(result.st);
    for (const mp of result.manualPorts) manualPortSet.add(mp);
    for (const w of result.warnings) {
      warnings.push(`Rung ${rung.number}: ${w}`);
    }
    lines.push("");
  }
  return {
    st: lines.join("\n"),
    rungCount: rungs.length,
    failedRungCount,
    manualPortInstructions: Array.from(manualPortSet).sort(),
    warnings,
  };
}
