/**
 * Incremental migration model.
 *
 * The canonical pipeline is activated one operation family at a time. Each
 * family has an explicit, version-controlled status. Families that are not yet
 * `canonical_active` are still handled by the legacy engine — this is the
 * transition mechanism that lets canonical and legacy coexist WITHOUT
 * pretending the migration is complete.
 */
import type { Expression } from "../ir/expressions";
import type { Statement } from "../ir/statements";
import type { SemanticOperationNode } from "../ir/operations";
import type { CanonicalProgram } from "../ir/project";

export type MigrationFamily =
  | "expressions"
  | "assignments"
  | "control_flow"
  | "declarations"
  | "arrays_structures"
  | "conversions"
  | "timers"
  | "counters"
  | "copy_move"
  | "bit_operations"
  | "calls"
  | "function_blocks"
  | "ladder"
  | "project_metadata"
  | "hardware_mapping"
  | "unsupported_manual_port";

export type MigrationStatus =
  | "legacy_only"
  | "canonical_shadow"
  | "canonical_active"
  | "canonical_complete";

/**
 * Version-controlled default migration policy (the authoritative record — NOT
 * an env var). Bumping a family to `canonical_active` here is what routes it
 * through the canonical production path.
 */
export const DEFAULT_FAMILY_STATUS: Record<MigrationFamily, MigrationStatus> = {
  expressions: "canonical_active",
  assignments: "canonical_active",
  control_flow: "canonical_active",
  declarations: "canonical_active",
  arrays_structures: "legacy_only",
  conversions: "legacy_only",
  timers: "legacy_only",
  counters: "legacy_only",
  copy_move: "legacy_only",
  bit_operations: "legacy_only",
  calls: "legacy_only",
  function_blocks: "legacy_only",
  ladder: "legacy_only",
  project_metadata: "legacy_only",
  hardware_mapping: "legacy_only",
  unsupported_manual_port: "legacy_only",
};

export class MigrationRegistry {
  private status: Record<MigrationFamily, MigrationStatus>;
  constructor(initial: Record<MigrationFamily, MigrationStatus> = DEFAULT_FAMILY_STATUS) {
    this.status = { ...initial };
  }
  get(family: MigrationFamily): MigrationStatus {
    return this.status[family];
  }
  isActive(family: MigrationFamily): boolean {
    const s = this.status[family];
    return s === "canonical_active" || s === "canonical_complete";
  }
  set(family: MigrationFamily, status: MigrationStatus): void {
    this.status[family] = status;
  }
  snapshot(): Record<MigrationFamily, MigrationStatus> {
    return { ...this.status };
  }
}

export function defaultRegistry(): MigrationRegistry {
  return new MigrationRegistry();
}

/** Family of a semantic operation, by canonical operation kind. */
function familyOfOperation(op: SemanticOperationNode["operation"]): MigrationFamily {
  if (op.startsWith("timer_")) return "timers";
  if (op.startsWith("counter_")) return "counters";
  if (op === "block_copy" || op === "synchronous_block_copy" || op === "masked_move") return "copy_move";
  if (op === "bit_set" || op === "bit_clear" || op === "shift_left" || op === "shift_right") return "bit_operations";
  if (op === "limit_test") return "expressions";
  if (op === "routine_call") return "calls";
  if (op === "read_input" || op === "write_output") return "hardware_mapping";
  if (op === "pid_control" || op === "message_transfer" || op === "motion_command") return "unsupported_manual_port";
  return "unsupported_manual_port";
}

export function familyOfStatement(stmt: Statement): MigrationFamily {
  switch (stmt.node) {
    case "assignment": return "assignments";
    case "conditional":
    case "case":
    case "for":
    case "while":
    case "repeat":
    case "return":
    case "exit":
    case "continue":
    case "noop":
      return "control_flow";
    case "call": return "calls";
    case "fb_invoke_stmt": return "function_blocks";
    case "semantic_operation": return familyOfOperation((stmt as SemanticOperationNode).operation);
    case "vendor_extension_stmt":
    case "unsupported_stmt":
      return "unsupported_manual_port";
    default:
      return "unsupported_manual_port";
  }
}

/** Expression kinds the canonical ST emitter fully supports (the `expressions` family). */
const CANONICAL_EXPRESSION_KINDS = new Set<string>([
  "literal", "symbol_ref", "member_access", "array_access", "unary", "binary",
  "comparison", "logical", "conversion",
]);

/** True if every expression under `expr` is emittable by the canonical expr family. */
export function expressionFullyCanonical(expr: Expression): boolean {
  if (!CANONICAL_EXPRESSION_KINDS.has(expr.node)) return false;
  switch (expr.node) {
    case "member_access": return expressionFullyCanonical(expr.object);
    case "array_access": return expressionFullyCanonical(expr.array) && expr.indices.every(expressionFullyCanonical);
    case "unary": return expressionFullyCanonical(expr.operand);
    case "binary":
    case "comparison":
    case "logical":
      return expressionFullyCanonical(expr.left) && expressionFullyCanonical(expr.right);
    case "conversion": return expressionFullyCanonical(expr.operand);
    default: return true;
  }
}
