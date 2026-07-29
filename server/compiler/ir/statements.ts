/**
 * Canonical statement nodes.
 */
import type { IrNodeBase } from "./nodes";
import type { Expression } from "./expressions";
import type { SemanticOperationNode } from "./operations";

export interface AssignmentStmt extends IrNodeBase {
  node: "assignment";
  target: Expression;
  value: Expression;
}

export interface IfBranch {
  condition: Expression;
  body: Statement[];
}
export interface ConditionalStmt extends IrNodeBase {
  node: "conditional";
  branches: IfBranch[]; // first is IF, rest are ELSIF
  elseBody: Statement[] | null;
}

export interface CaseBranch {
  labels: Expression[];
  body: Statement[];
}
export interface CaseStmt extends IrNodeBase {
  node: "case";
  selector: Expression;
  branches: CaseBranch[];
  elseBody: Statement[] | null;
}

export interface ForStmt extends IrNodeBase {
  node: "for";
  variable: string;
  from: Expression;
  to: Expression;
  by: Expression | null;
  body: Statement[];
}

export interface WhileStmt extends IrNodeBase {
  node: "while";
  condition: Expression;
  body: Statement[];
}

export interface RepeatStmt extends IrNodeBase {
  node: "repeat";
  body: Statement[];
  until: Expression;
}

export interface ReturnStmt extends IrNodeBase {
  node: "return";
}
export interface ExitStmt extends IrNodeBase {
  node: "exit";
}
export interface ContinueStmt extends IrNodeBase {
  node: "continue";
}

export interface CallStmt extends IrNodeBase {
  node: "call";
  name: string;
  args: Expression[];
  callKind: "function" | "routine" | "program" | "unknown";
}

export interface FbInvokeStmt extends IrNodeBase {
  node: "fb_invoke_stmt";
  instance: string;
  namedArgs: { name: string; value: Expression }[];
}

export interface VendorExtensionStmt extends IrNodeBase {
  node: "vendor_extension_stmt";
  vendorName: string;
  rawArgs: string[];
}

export interface UnsupportedStmt extends IrNodeBase {
  node: "unsupported_stmt";
  raw: string;
  reason: string;
}

/** Explicit, semantically-meaningful no-op (e.g. NOP), never silent padding. */
export interface NoOpStmt extends IrNodeBase {
  node: "noop";
  reason: string;
}

export type Statement =
  | AssignmentStmt
  | ConditionalStmt
  | CaseStmt
  | ForStmt
  | WhileStmt
  | RepeatStmt
  | ReturnStmt
  | ExitStmt
  | ContinueStmt
  | CallStmt
  | FbInvokeStmt
  | SemanticOperationNode
  | VendorExtensionStmt
  | UnsupportedStmt
  | NoOpStmt;

export const STATEMENT_NODE_KINDS = new Set<string>([
  "assignment", "conditional", "case", "for", "while", "repeat", "return",
  "exit", "continue", "call", "fb_invoke_stmt", "semantic_operation",
  "vendor_extension_stmt", "unsupported_stmt", "noop",
]);
