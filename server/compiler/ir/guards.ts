/**
 * IR type guards.
 */
import { EXPRESSION_NODE_KINDS, type Expression } from "./expressions";
import { STATEMENT_NODE_KINDS, type Statement } from "./statements";
import type { IrNodeBase } from "./nodes";

export function isIrNode(v: unknown): v is IrNodeBase & { node: string } {
  return !!v && typeof v === "object" && typeof (v as Record<string, unknown>).id === "string" && typeof (v as Record<string, unknown>).node === "string";
}

export function isExpression(v: unknown): v is Expression {
  return isIrNode(v) && EXPRESSION_NODE_KINDS.has(v.node);
}

export function isStatement(v: unknown): v is Statement {
  return isIrNode(v) && STATEMENT_NODE_KINDS.has(v.node);
}

export function isSemanticOperation(v: unknown): boolean {
  return isIrNode(v) && v.node === "semantic_operation";
}
