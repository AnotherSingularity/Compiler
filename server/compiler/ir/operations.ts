/**
 * Canonical semantic operations (invariant C). Vendor mnemonics (TON, RTO, CTU,
 * COP, CPS, BMOV, MVM, RES, LIM, ...) are recorded only in `origin.sourceMnemonic`
 * / `vendorAnnotations`, never as `operation`.
 */
import type { IrNodeBase } from "./nodes";
import type { Expression } from "./expressions";
import type { TranslationDisposition } from "../contracts/ids";

export type SemanticOperationKind =
  | "timer_on_delay"
  | "timer_off_delay"
  | "timer_retentive"
  | "timer_reset"
  | "counter_up"
  | "counter_down"
  | "counter_reset"
  | "block_copy"
  | "synchronous_block_copy"
  | "masked_move"
  | "limit_test"
  | "bit_set"
  | "bit_clear"
  | "shift_left"
  | "shift_right"
  | "fifo_load"
  | "fifo_unload"
  | "pid_control"
  | "message_transfer"
  | "motion_command"
  | "read_input"
  | "write_output"
  | "routine_call"
  | "vendor_extension"
  | "unsupported";

export const ALL_IR_OPERATION_KINDS: readonly SemanticOperationKind[] = [
  "timer_on_delay", "timer_off_delay", "timer_retentive", "timer_reset",
  "counter_up", "counter_down", "counter_reset", "block_copy",
  "synchronous_block_copy", "masked_move", "limit_test", "bit_set", "bit_clear",
  "shift_left", "shift_right", "fifo_load", "fifo_unload", "pid_control",
  "message_transfer", "motion_command", "read_input", "write_output",
  "routine_call", "vendor_extension", "unsupported",
] as const;

/** Vendor mnemonics that must never be used as a canonical operation identity. */
export const RESERVED_VENDOR_MNEMONICS = new Set<string>([
  "TON", "TOF", "RTO", "TONR", "CTU", "CTD", "CTUD", "RES", "COP", "CPS", "BMOV",
  "MVM", "MOV", "LIM", "LIMIT", "MSG", "PID", "PIDE", "MAJ", "MAM", "OTE", "OTL", "OTU",
]);

export interface OperationArgument {
  role: string;
  value: Expression;
}

/**
 * A semantic operation invocation. `operation` is canonical; `vendorAnnotations`
 * preserves the original call form for round-trip/provenance and for lowering.
 */
export interface SemanticOperationNode extends IrNodeBase {
  node: "semantic_operation";
  operation: SemanticOperationKind;
  args: OperationArgument[];
  /** Disposition assigned by lowering/capability evaluation (Stage 3/4). */
  disposition?: TranslationDisposition;
  vendorAnnotations?: {
    mnemonic?: string;
    language?: string;
    rawArgs?: string[];
  };
}

export function isSemanticOperationKind(k: string): k is SemanticOperationKind {
  return (ALL_IR_OPERATION_KINDS as readonly string[]).includes(k);
}
