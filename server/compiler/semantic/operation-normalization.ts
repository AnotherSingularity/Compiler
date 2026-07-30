/**
 * Operation normalization (Stage 2).
 *
 * Rewrites canonical `call` / `fb_invoke_stmt` nodes whose name is a known
 * vendor mnemonic into canonical `semantic_operation` nodes (invariant C). The
 * vendor mnemonic is preserved in `origin.sourceMnemonic` and
 * `vendorAnnotations.mnemonic` — never as the operation identity. A default
 * disposition hint is attached (capability enforcement in Stage 4 is
 * authoritative). Unknown mnemonics are left untouched.
 *
 * This pass is pure and deterministic: it preserves node ids and statement
 * order, so serialized/semantic hashes stay stable for unaffected nodes.
 */
import type { LanguageId, TranslationDisposition } from "../contracts/ids";
import type { Expression } from "../ir/expressions";
import type {
  Statement,
  CallStmt,
  ConditionalStmt,
  CaseStmt,
  ForStmt,
  WhileStmt,
  RepeatStmt,
} from "../ir/statements";
import type { SemanticOperationNode, SemanticOperationKind, OperationArgument } from "../ir/operations";
import type { CanonicalProgram } from "../ir/project";
import type { CanonicalRoutine, CanonicalFunction, CanonicalFunctionBlock } from "../ir/declarations";
import type { SourceOrigin } from "../ir/nodes";

interface MnemonicRule {
  operation: SemanticOperationKind;
  disposition: TranslationDisposition;
  /** Semantic role names for positional args (best effort). */
  roles?: string[];
}

/**
 * Vendor mnemonic → canonical operation. Deliberately conservative: mnemonics
 * whose canonical identity depends on operand types (e.g. RES, which resets a
 * timer OR a counter) are NOT mapped here — that needs type resolution
 * (later Stage 2 work) and mapping them now would be a guess.
 */
const MNEMONIC_RULES: Record<string, MnemonicRule> = {
  TON: { operation: "timer_on_delay", disposition: "lossy", roles: ["timer", "preset", "accum"] },
  TOF: { operation: "timer_off_delay", disposition: "lossy", roles: ["timer", "preset", "accum"] },
  RTO: { operation: "timer_retentive", disposition: "lossy", roles: ["timer", "preset", "accum"] },
  TONR: { operation: "timer_retentive", disposition: "lossy", roles: ["timer", "preset", "accum"] },
  CTU: { operation: "counter_up", disposition: "lossy", roles: ["counter", "preset", "accum"] },
  CTD: { operation: "counter_down", disposition: "lossy", roles: ["counter", "preset", "accum"] },
  COP: { operation: "block_copy", disposition: "equivalent_lowering", roles: ["source", "dest", "count"] },
  BMOV: { operation: "block_copy", disposition: "equivalent_lowering", roles: ["source", "dest", "count"] },
  CPS: { operation: "synchronous_block_copy", disposition: "lossy", roles: ["source", "dest", "count"] },
  MVM: { operation: "masked_move", disposition: "equivalent_lowering", roles: ["source", "mask", "dest"] },
  LIM: { operation: "limit_test", disposition: "equivalent_lowering", roles: ["low", "test", "high"] },
  LIMIT: { operation: "limit_test", disposition: "equivalent_lowering", roles: ["low", "test", "high"] },
  MSG: { operation: "message_transfer", disposition: "unsupported", roles: ["message"] },
  PID: { operation: "pid_control", disposition: "manual_port", roles: ["loop"] },
  PIDE: { operation: "pid_control", disposition: "manual_port", roles: ["loop"] },
  JSR: { operation: "routine_call", disposition: "exact", roles: ["routine"] },
};

export function mnemonicRule(name: string): MnemonicRule | undefined {
  return MNEMONIC_RULES[name.toUpperCase()];
}

function makeArgs(args: Expression[], roles?: string[]): OperationArgument[] {
  return args.map((value, i) => ({ role: roles?.[i] ?? `arg${i}`, value }));
}

function rewriteCall(stmt: CallStmt): Statement {
  const rule = mnemonicRule(stmt.name);
  if (!rule) return stmt;
  // Preserve the node id; upgrade origin with the source mnemonic.
  const origin: SourceOrigin =
    stmt.origin.kind === "source"
      ? { ...stmt.origin, sourceMnemonic: stmt.name.toUpperCase() }
      : ({ kind: "source", sourceId: "<unknown>", language: "iec-61131-3-st" as LanguageId, artifactKind: "structured_text", span: { sourceId: "<unknown>", start: { offset: -1, line: 1, column: 1 }, end: { offset: -1, line: 1, column: 1 } }, sourceMnemonic: stmt.name.toUpperCase() } as SourceOrigin);
  const op: SemanticOperationNode = {
    node: "semantic_operation",
    id: stmt.id,
    origin,
    operation: rule.operation,
    args: makeArgs(stmt.args, rule.roles),
    disposition: rule.disposition,
    vendorAnnotations: { mnemonic: stmt.name.toUpperCase() },
  };
  return op;
}

function rewriteStatements(list: Statement[]): Statement[] {
  return list.map(rewriteStatement);
}

function rewriteStatement(stmt: Statement): Statement {
  switch (stmt.node) {
    case "call":
      return rewriteCall(stmt);
    case "conditional": {
      const s = stmt as ConditionalStmt;
      return {
        ...s,
        branches: s.branches.map((b) => ({ condition: b.condition, body: rewriteStatements(b.body) })),
        elseBody: s.elseBody ? rewriteStatements(s.elseBody) : null,
      };
    }
    case "case": {
      const s = stmt as CaseStmt;
      return { ...s, branches: s.branches.map((b) => ({ labels: b.labels, body: rewriteStatements(b.body) })), elseBody: s.elseBody ? rewriteStatements(s.elseBody) : null };
    }
    case "for": {
      const s = stmt as ForStmt;
      return { ...s, body: rewriteStatements(s.body) };
    }
    case "while": {
      const s = stmt as WhileStmt;
      return { ...s, body: rewriteStatements(s.body) };
    }
    case "repeat": {
      const s = stmt as RepeatStmt;
      return { ...s, body: rewriteStatements(s.body) };
    }
    default:
      return stmt;
  }
}

function rewriteRoutine<T extends CanonicalRoutine | CanonicalFunction | CanonicalFunctionBlock>(unit: T): T {
  return { ...unit, body: rewriteStatements(unit.body) };
}

/**
 * Return a new program with vendor-mnemonic calls normalized to canonical
 * semantic operations. Pure; input is not mutated.
 */
export function normalizeProgramOperations(program: CanonicalProgram): CanonicalProgram {
  return {
    ...program,
    routines: program.routines.map(rewriteRoutine),
    functions: program.functions.map(rewriteRoutine),
    functionBlocks: program.functionBlocks.map(rewriteRoutine),
  };
}
