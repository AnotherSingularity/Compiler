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
  arrays_structures: "canonical_active",
  conversions: "canonical_active",
  timers: "canonical_active",
  counters: "canonical_active",
  copy_move: "canonical_active",
  bit_operations: "canonical_active",
  calls: "canonical_active",
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
  if (op === "limit_test") return "copy_move";
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

/**
 * A statement routes canonical only if its ENTIRE subtree is canonically
 * emittable: its family is active, its expressions are canonical, AND every
 * nested statement is itself fully canonical. If a canonical-active statement
 * (e.g. IF) contains a legacy-only node (e.g. a timer) it is structurally
 * inseparable — the whole statement routes to legacy (the active nodes inside
 * are NOT counted as canonical; no pretending).
 */
export function statementFullyCanonical(stmt: Statement, isActive: (f: MigrationFamily) => boolean): boolean {
  const fam = familyOfStatement(stmt);
  if (!isActive(fam)) return false;
  if (!statementOwnExpressions(stmt).every((e) => expressionFullyCanonical(e, isActive))) return false;
  return childStatementsOf(stmt).every((s) => statementFullyCanonical(s, isActive));
}

function statementOwnExpressions(stmt: Statement): Expression[] {
  switch (stmt.node) {
    case "assignment": return [stmt.target, stmt.value];
    case "conditional": return stmt.branches.map((b) => b.condition);
    case "case": return [stmt.selector, ...stmt.branches.flatMap((b) => b.labels)];
    case "for": return [stmt.from, stmt.to, ...(stmt.by ? [stmt.by] : [])];
    case "while": return [stmt.condition];
    case "repeat": return [stmt.until];
    default: return [];
  }
}

function childStatementsOf(stmt: Statement): Statement[] {
  switch (stmt.node) {
    case "conditional": return [...stmt.branches.flatMap((b) => b.body), ...(stmt.elseBody ?? [])];
    case "case": return [...stmt.branches.flatMap((b) => b.body), ...(stmt.elseBody ?? [])];
    case "for":
    case "while":
    case "repeat": return stmt.body;
    default: return [];
  }
}

/** Expression kinds the canonical ST emitter fully supports (the `expressions` family). */
const CANONICAL_EXPRESSION_KINDS = new Set<string>([
  "literal", "symbol_ref", "member_access", "array_access", "unary", "binary",
  "comparison", "logical", "conversion", "range", "instance_field",
]);

/**
 * Vendor timer/counter status/config fields that the legacy emitters rewrite
 * across dialects (AB `.DN/.PRE/.ACC` ↔ IEC `.Q/.PT/.ET/.PV/.CV`). A canonical
 * member-access emits the field name verbatim, which would DIVERGE from the
 * target-correct rewrite. Until timers/counters are canonically modeled as
 * `instance_field` accesses, a member access on one of these names is NOT
 * canonically safe and must route to the legacy engine (which rewrites it
 * correctly). This prevents the canonical path from emitting semantically wrong
 * output (e.g. `T.DN` where the Mitsubishi target requires `T.Q`).
 */
const VENDOR_REWRITTEN_INSTANCE_FIELDS = new Set<string>([
  "DN", "PRE", "ACC", "Q", "PT", "ET", "PV", "CV",
]);

/**
 * True if every expression under `expr` is emittable by the canonical expr
 * family AND every family it requires is active. `isActive` gates family-specific
 * expression kinds (e.g. a `conversion` node routes canonical only when the
 * `conversions` family is active); it defaults to treating every family as
 * active for callers that only care about emitter support.
 */
export function expressionFullyCanonical(
  expr: Expression,
  isActive: (f: MigrationFamily) => boolean = () => true,
): boolean {
  if (!CANONICAL_EXPRESSION_KINDS.has(expr.node)) return false;
  switch (expr.node) {
    case "member_access":
      if (VENDOR_REWRITTEN_INSTANCE_FIELDS.has(expr.member.toUpperCase())) return false;
      return expressionFullyCanonical(expr.object, isActive);
    case "array_access": return expressionFullyCanonical(expr.array, isActive) && expr.indices.every((e) => expressionFullyCanonical(e, isActive));
    case "unary": return expressionFullyCanonical(expr.operand, isActive);
    case "binary":
    case "comparison":
    case "logical":
      return expressionFullyCanonical(expr.left, isActive) && expressionFullyCanonical(expr.right, isActive);
    case "conversion":
      return isActive("conversions") && expressionFullyCanonical(expr.operand, isActive);
    case "range": return expressionFullyCanonical(expr.low, isActive) && expressionFullyCanonical(expr.high, isActive);
    case "instance_field":
      // A timer/counter field is canonical only when its instance family is active.
      return isActive(expr.instanceKind === "counter" ? "counters" : "timers");
    default: return true;
  }
}
