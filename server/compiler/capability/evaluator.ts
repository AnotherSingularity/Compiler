/**
 * Authoritative capability evaluation.
 *
 * The per-target `CapabilityManifest` declares, machine-readably, what each
 * backend can do and with what disposition. This module makes that manifest
 * AUTHORITATIVE at compile time instead of merely informational: it maps a
 * canonical IR operation to its capability rule and re-stamps the operation's
 * disposition from the manifest. Where the manifest declares a rule, the
 * manifest wins; where it does not, the operation keeps the disposition assigned
 * by operation-normalization (never silently upgraded to "supported").
 *
 * A separate consistency gate (`verify:capabilities`) proves the manifest and
 * the normalization dispositions agree for every emittable operation, so the two
 * can never drift apart unnoticed.
 */
import type { TranslationDisposition } from "../contracts/ids";
import type { CapabilityManifest, CapabilityRule } from "../contracts/capability";
import type { SemanticOperationKind as CapabilityOperationKey } from "../contracts/operations";
import type { SemanticOperationKind as IrOperationKind } from "../ir/operations";
import type { Statement } from "../ir/statements";
import type { CanonicalProgram } from "../ir/project";
import type { CanonicalRoutine, CanonicalFunction, CanonicalFunctionBlock } from "../ir/declarations";

/**
 * Bridge from the IR operation taxonomy (snake_case, pipeline-internal) to the
 * capability-manifest taxonomy (PascalCase, backend-facing). Only operations
 * that have a manifest counterpart are listed. Operations intentionally NOT
 * mapped (they carry no manifest capability yet) are recorded in
 * `UNMAPPED_IR_OPERATIONS` so the gate can tell "no counterpart" apart from a
 * forgotten mapping.
 */
export const IR_TO_CAPABILITY_KEY: Partial<Record<IrOperationKind, CapabilityOperationKey>> = {
  timer_on_delay: "TimerOnDelay",
  timer_off_delay: "TimerOffDelay",
  timer_retentive: "TimerRetentive",
  counter_up: "CounterUp",
  counter_down: "CounterDown",
  counter_reset: "CounterReset",
  block_copy: "BlockCopy",
  synchronous_block_copy: "SynchronousBlockCopy",
  masked_move: "MaskedMove",
  pid_control: "PIDControl",
  message_transfer: "MessageTransfer",
  motion_command: "MotionCommand",
  read_input: "ReadInput",
  write_output: "WriteOutput",
  routine_call: "ProgramCall",
  vendor_extension: "VendorExtension",
  unsupported: "UnsupportedOperation",
};

/**
 * IR operations that deliberately have no capability-manifest key. `limit_test`
 * lowers to an inline expression (LIMIT()) handled by the expressions family and
 * carries no standalone capability; `timer_reset` is resolved into a concrete
 * reset form by the counters/timers family. These are exempt from the gate's
 * "must be declared" rule but still logged for visibility.
 */
export const UNMAPPED_IR_OPERATIONS = new Set<IrOperationKind>(["limit_test", "timer_reset", "fifo_load", "fifo_unload", "bit_set", "bit_clear", "shift_left", "shift_right"]);

export interface CapabilityEvaluation {
  capabilityKey: CapabilityOperationKey | null;
  rule: CapabilityRule | null;
  /** The disposition to use: manifest rule if declared, else the fallback. */
  disposition: TranslationDisposition;
  /** True when the manifest had no rule for this operation. */
  undeclared: boolean;
}

/** Evaluate one IR operation against a target manifest. */
export function evaluateOperation(
  irKind: IrOperationKind,
  manifest: CapabilityManifest,
  fallback: TranslationDisposition,
): CapabilityEvaluation {
  const capabilityKey = IR_TO_CAPABILITY_KEY[irKind] ?? null;
  const rule = capabilityKey ? manifest.operations[capabilityKey] ?? null : null;
  return {
    capabilityKey,
    rule,
    disposition: rule ? rule.disposition : fallback,
    undeclared: capabilityKey !== null && rule === null,
  };
}

// ── Re-stamp dispositions across a program (authoritative pass) ────────────

function restampStatements(stmts: Statement[], manifest: CapabilityManifest): Statement[] {
  return stmts.map((s) => restampStatement(s, manifest));
}

function restampStatement(stmt: Statement, manifest: CapabilityManifest): Statement {
  switch (stmt.node) {
    case "semantic_operation": {
      const fallback = stmt.disposition ?? "unsupported";
      const evalr = evaluateOperation(stmt.operation, manifest, fallback);
      return evalr.disposition === stmt.disposition ? stmt : { ...stmt, disposition: evalr.disposition };
    }
    case "conditional":
      return { ...stmt, branches: stmt.branches.map((b) => ({ ...b, body: restampStatements(b.body, manifest) })), elseBody: stmt.elseBody ? restampStatements(stmt.elseBody, manifest) : null };
    case "case":
      return { ...stmt, branches: stmt.branches.map((b) => ({ ...b, body: restampStatements(b.body, manifest) })), elseBody: stmt.elseBody ? restampStatements(stmt.elseBody, manifest) : null };
    case "for":
    case "while":
    case "repeat":
      return { ...stmt, body: restampStatements(stmt.body, manifest) };
    default:
      return stmt;
  }
}

function restampUnit<T extends CanonicalRoutine | CanonicalFunction | CanonicalFunctionBlock>(unit: T, manifest: CapabilityManifest): T {
  return { ...unit, body: restampStatements(unit.body, manifest) };
}

/**
 * Return a new program whose semantic operations carry the AUTHORITATIVE
 * disposition from the target manifest (manifest-declared rules win; undeclared
 * operations keep their normalization disposition). Pure; ids/order preserved.
 */
export function applyCapabilityDispositions(program: CanonicalProgram, manifest: CapabilityManifest): CanonicalProgram {
  return {
    ...program,
    routines: program.routines.map((r) => restampUnit(r, manifest)),
    functions: program.functions.map((f) => restampUnit(f, manifest)),
    functionBlocks: program.functionBlocks.map((fb) => restampUnit(fb, manifest)),
  };
}
