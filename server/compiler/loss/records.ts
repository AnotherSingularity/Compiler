/**
 * Structured semantic-loss records (invariant D).
 *
 * A semantic loss is any place where the canonical meaning of the source cannot
 * be fully and portably reproduced in the target: a timer whose enable/preset
 * must be re-wired by hand, an unsupported instruction, a vendor extension, a
 * non-zero-based array flattened to a zero-based one. These records are the
 * AUTHORITATIVE source of truth — generated `(* TODO *)` comments are only a
 * human-facing echo of them. `CompileResult.completeness` is derived from them,
 * so a program that carries losses can never silently report as complete.
 *
 * Losses are classified from a node's disposition (assigned by operation
 * normalization / capability evaluation), never re-guessed here. Dispositions
 * that preserve behavior (`exact`, `equivalent_lowering`) are NOT losses.
 */
import type { LanguageId, TranslationDisposition } from "../contracts/ids";
import type { SourceSpan } from "../contracts/source";
import type { SemanticLossRecord } from "../contracts/compile";
import type { Statement } from "../ir/statements";
import type { Expression, ConversionExpr, ConversionSafety } from "../ir/expressions";
import type { SemanticOperationNode, SemanticOperationKind } from "../ir/operations";
import type { CanonicalProgram } from "../ir/project";
import type { NodeOrigin } from "../ir/nodes";
import type { CanonicalType } from "../ir/types";

export interface LossContext {
  sourceLanguage: LanguageId;
  targetLanguage: LanguageId;
}

/** Dispositions that constitute a real semantic loss (behavior not preserved as-is). */
const LOSSY_DISPOSITIONS = new Set<TranslationDisposition>(["lossy", "manual_port", "unsupported", "synthesized"]);

interface OpLossProfile {
  category: string;
  sourceSemantics: string[];
  targetSemantics: string[];
  requiredAction: string;
  describe: (mnemonic: string) => string;
}

const OP_PROFILES: Partial<Record<SemanticOperationKind, OpLossProfile>> = {
  timer_on_delay: timerProfile("on-delay"),
  timer_off_delay: timerProfile("off-delay"),
  timer_retentive: timerProfile("retentive"),
  counter_up: counterProfile("up"),
  counter_down: counterProfile("down"),
  synchronous_block_copy: {
    category: "copy_move_atomicity",
    sourceSemantics: ["CPS performs a synchronous/atomic block copy (no interruption mid-copy)"],
    targetSemantics: ["target block-move (BMOV) is not guaranteed atomic"],
    requiredAction: "Confirm no concurrent task reads the destination mid-copy, or add a target-specific atomic/lock mechanism.",
    describe: (m) => `Synchronous block copy (${m}) lowered to a non-atomic block move — atomicity is not preserved.`,
  },
  counter_reset: {
    category: "counters",
    sourceSemantics: ["RES resets accumulator to zero for a timer or counter instance"],
    targetSemantics: ["explicit reset of the resolved instance (R / CU:=FALSE / ACC:=0)"],
    requiredAction: "Confirm the reset targets the intended instance and reset path.",
    describe: (m) => `Reset (${m}) — instance kind must be resolved to emit the correct reset form.`,
  },
  pid_control: {
    category: "process_control",
    sourceSemantics: ["vendor PID loop with tuning/config block"],
    targetSemantics: ["no portable equivalent — manual port required"],
    requiredAction: "Re-implement the loop using the target platform's PID facility.",
    describe: (m) => `PID loop (${m}) has no portable equivalent and must be ported manually.`,
  },
  message_transfer: {
    category: "communications",
    sourceSemantics: ["vendor messaging/MSG transfer with connection config"],
    targetSemantics: ["no portable equivalent"],
    requiredAction: "Re-create the messaging path on the target platform.",
    describe: (m) => `Message transfer (${m}) is platform-specific and unsupported for automatic translation.`,
  },
  motion_command: {
    category: "motion",
    sourceSemantics: ["vendor motion command"],
    targetSemantics: ["no portable equivalent"],
    requiredAction: "Re-create the motion command on the target platform.",
    describe: (m) => `Motion command (${m}) is platform-specific and must be ported manually.`,
  },
};

function timerProfile(variant: string): OpLossProfile {
  return {
    category: "timers",
    sourceSemantics: [
      "enable (IN) is the rung/branch condition, not a call argument",
      "preset (.PRE) is a DINT in milliseconds",
    ],
    targetSemantics: [
      "IEC timer FB IN input driven every scan",
      "TIME preset (PT), e.g. T#5s",
    ],
    requiredAction: "Wire IN to the original enabling condition and set PT from the source preset.",
    describe: (m) => `Timer ${variant} (${m}) — IN enable and PT preset are not lexically derivable; emitted with placeholders requiring manual completion.`,
  };
}
function counterProfile(dir: string): OpLossProfile {
  return {
    category: "counters",
    sourceSemantics: [
      "count input is the rung condition, not a call argument",
      "reset (RES) and preset (.PRE) come from rung context",
    ],
    targetSemantics: ["IEC counter FB CU/CD/R inputs and PV preset"],
    requiredAction: "Wire the count/reset inputs and set PV from the source preset.",
    describe: (m) => `Counter ${dir} (${m}) — count/reset inputs and PV preset require manual wiring.`,
  };
}

function spanOf(origin: NodeOrigin): SourceSpan | undefined {
  return origin.kind === "source" ? origin.span : undefined;
}

function typeSpelling(t: CanonicalType): string {
  return t.sourceSpelling ?? t.kind;
}

/** Conversion safety → (disposition, category, description, action). Safe classes → null. */
const CONVERSION_LOSS: Partial<Record<ConversionSafety, { disposition: TranslationDisposition; category: string; describe: (f: string, t: string) => string; action: string }>> = {
  narrowing: { disposition: "lossy", category: "conversion_narrowing", describe: (f, t) => `Narrowing conversion ${f}→${t} truncates or overflows values outside the target range.`, action: "Confirm all runtime values fit the target type, or synthesize a checked conversion." },
  signedness_change: { disposition: "lossy", category: "conversion_signedness", describe: (f, t) => `Signedness change ${f}→${t} reinterprets the sign bit; negative or high-bit values change meaning.`, action: "Confirm the value range excludes the affected sign/high-bit region." },
  precision_loss: { disposition: "lossy", category: "conversion_precision", describe: (f, t) => `Precision-reducing conversion ${f}→${t} loses mantissa/representation.`, action: "Confirm the precision loss is acceptable for this signal." },
  reinterpretation: { disposition: "manual_port", category: "conversion_reinterpretation", describe: (f, t) => `Bit reinterpretation ${f}→${t}; target semantics must be verified.`, action: "Verify the target performs the intended bit reinterpretation." },
  vendor_defined: { disposition: "manual_port", category: "conversion_vendor", describe: (f, t) => `Vendor-defined conversion ${f}→${t}; a target library/construct is required.`, action: "Provide the target conversion facility or port manually." },
  invalid: { disposition: "unsupported", category: "conversion_invalid", describe: (f, t) => `Invalid conversion ${f}→${t} has no meaning-preserving target form.`, action: "Remove or replace this conversion." },
};

function conversionLoss(conv: ConversionExpr, ctx: LossContext): SemanticLossRecord | null {
  const profile = CONVERSION_LOSS[conv.safety];
  if (!profile) return null; // identity / widening → no loss
  const from = typeSpelling(conv.from), to = typeSpelling(conv.to);
  return {
    id: `loss_${conv.id}`, nodeId: conv.id, span: spanOf(conv.origin),
    sourceLanguage: ctx.sourceLanguage, targetLanguage: ctx.targetLanguage,
    category: profile.category, disposition: profile.disposition,
    description: profile.describe(from, to),
    sourceSemantics: [`value of type ${from}`], targetSemantics: [`value of type ${to} (${conv.safety})`],
    requiredAction: profile.action,
  };
}

/** Collect conversion losses from an expression tree. */
function walkExpr(expr: Expression, ctx: LossContext, out: SemanticLossRecord[]): void {
  switch (expr.node) {
    case "conversion": {
      const rec = conversionLoss(expr, ctx);
      if (rec) out.push(rec);
      walkExpr(expr.operand, ctx, out);
      break;
    }
    case "member_access": walkExpr(expr.object, ctx, out); break;
    case "array_access": walkExpr(expr.array, ctx, out); expr.indices.forEach((i) => walkExpr(i, ctx, out)); break;
    case "unary": walkExpr(expr.operand, ctx, out); break;
    case "binary":
    case "comparison":
    case "logical": walkExpr(expr.left, ctx, out); walkExpr(expr.right, ctx, out); break;
    case "range": walkExpr(expr.low, ctx, out); walkExpr(expr.high, ctx, out); break;
    case "function_call": expr.args.forEach((a) => walkExpr(a, ctx, out)); break;
    case "fb_invoke": expr.namedArgs.forEach((a) => walkExpr(a.value, ctx, out)); break;
    default: break;
  }
}

function ownExpressions(stmt: Statement): Expression[] {
  switch (stmt.node) {
    case "assignment": return [stmt.target, stmt.value];
    case "conditional": return stmt.branches.map((b) => b.condition);
    case "case": return [stmt.selector, ...stmt.branches.flatMap((b) => b.labels)];
    case "for": return [stmt.from, stmt.to, ...(stmt.by ? [stmt.by] : [])];
    case "while": return [stmt.condition];
    case "repeat": return [stmt.until];
    case "call": return stmt.args;
    case "semantic_operation": return stmt.args.map((a) => a.value);
    default: return [];
  }
}

function operationLoss(op: SemanticOperationNode, ctx: LossContext): SemanticLossRecord | null {
  const disposition = op.disposition;
  if (!disposition || !LOSSY_DISPOSITIONS.has(disposition)) return null;
  const mnemonic = op.vendorAnnotations?.mnemonic ?? op.operation;
  const profile = OP_PROFILES[op.operation];
  const category = profile?.category ?? "operation";
  return {
    id: `loss_${op.id}`,
    nodeId: op.id,
    span: spanOf(op.origin),
    sourceLanguage: ctx.sourceLanguage,
    targetLanguage: ctx.targetLanguage,
    category,
    disposition,
    description: profile ? profile.describe(mnemonic) : `${op.operation} (${mnemonic}) — ${disposition} translation.`,
    sourceSemantics: profile?.sourceSemantics ?? [`vendor operation ${mnemonic}`],
    targetSemantics: profile?.targetSemantics ?? ["no exact target equivalent"],
    requiredAction: profile?.requiredAction ?? "Review the translated node against the source semantics.",
  };
}

function walk(stmts: Statement[], ctx: LossContext, out: SemanticLossRecord[]): void {
  for (const s of stmts) {
    // Conversion losses live in a statement's own expressions (any node kind).
    for (const e of ownExpressions(s)) walkExpr(e, ctx, out);
    switch (s.node) {
      case "semantic_operation": {
        const rec = operationLoss(s, ctx);
        if (rec) out.push(rec);
        break;
      }
      case "unsupported_stmt":
        out.push({
          id: `loss_${s.id}`, nodeId: s.id, span: spanOf(s.origin),
          sourceLanguage: ctx.sourceLanguage, targetLanguage: ctx.targetLanguage,
          category: "unsupported", disposition: "unsupported",
          description: `Unsupported construct: ${s.reason}`,
          sourceSemantics: [s.raw.slice(0, 200)], targetSemantics: ["no target equivalent"],
          requiredAction: "Port this construct manually.",
        });
        break;
      case "vendor_extension_stmt":
        out.push({
          id: `loss_${s.id}`, nodeId: s.id, span: spanOf(s.origin),
          sourceLanguage: ctx.sourceLanguage, targetLanguage: ctx.targetLanguage,
          category: "vendor_extension", disposition: "manual_port",
          description: `Vendor extension ${s.vendorName} has no portable canonical form.`,
          sourceSemantics: [`${s.vendorName}(${s.rawArgs.join(", ")})`], targetSemantics: ["no target equivalent"],
          requiredAction: "Re-implement the vendor extension on the target platform.",
        });
        break;
      case "conditional":
        s.branches.forEach((b) => walk(b.body, ctx, out));
        if (s.elseBody) walk(s.elseBody, ctx, out);
        break;
      case "case":
        s.branches.forEach((b) => walk(b.body, ctx, out));
        if (s.elseBody) walk(s.elseBody, ctx, out);
        break;
      case "for":
      case "while":
      case "repeat":
        walk(s.body, ctx, out);
        break;
      default:
        break;
    }
  }
}

/** Collect semantic-loss records for a whole program's routines/functions/FBs. */
export function collectProgramLosses(program: CanonicalProgram, ctx: LossContext): SemanticLossRecord[] {
  const out: SemanticLossRecord[] = [];
  for (const r of program.routines) walk(r.body, ctx, out);
  for (const f of program.functions) walk(f.body, ctx, out);
  for (const fb of program.functionBlocks) walk(fb.body, ctx, out);
  // Deterministic order: by node id (structural, stable).
  out.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  return out;
}

/**
 * Honest completeness from loss records + engine state. A program that carries
 * any real loss can never report `executable_complete`.
 */
export function completenessFromLosses(
  losses: SemanticLossRecord[],
  opts: { hasError: boolean; outputEmpty: boolean; legacyNodeCount: number },
): "failed" | "generated" | "review_required" | "executable_complete" {
  if (opts.hasError && opts.outputEmpty) return "failed";
  if (losses.length > 0) return "review_required";
  // No recorded losses but some nodes still went through the legacy engine
  // (equivalent lowering not yet canonicalized): translated and behavior-
  // preserving, but not canonical-verified — honestly "generated".
  if (opts.legacyNodeCount > 0) return "generated";
  return "executable_complete";
}
