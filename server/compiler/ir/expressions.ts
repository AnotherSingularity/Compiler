/**
 * Canonical expression nodes. Every expression exposes its resolved (or
 * unresolved) type.
 */
import type { IrNodeBase } from "./nodes";
import type { CanonicalType } from "./types";

export type BinaryOperator = "+" | "-" | "*" | "/" | "mod" | "pow";
export type ComparisonOperator = "=" | "<>" | "<" | "<=" | ">" | ">=";
export type LogicalOperator = "and" | "or" | "xor";
export type UnaryOperator = "neg" | "not";

export type LiteralValueKind = "int" | "real" | "bool" | "string" | "time";

export interface LiteralExpr extends IrNodeBase {
  node: "literal";
  valueKind: LiteralValueKind;
  /** Canonical textual value, verbatim from source (not re-parsed). */
  raw: string;
  type: CanonicalType;
}

export interface SymbolRefExpr extends IrNodeBase {
  node: "symbol_ref";
  name: string;
  /** Resolved symbol id (scope path) or undefined when unresolved. */
  symbolId?: string;
  type: CanonicalType;
}

export interface MemberAccessExpr extends IrNodeBase {
  node: "member_access";
  object: Expression;
  member: string;
  type: CanonicalType;
}

export interface ArrayAccessExpr extends IrNodeBase {
  node: "array_access";
  array: Expression;
  indices: Expression[];
  type: CanonicalType;
}

export interface UnaryExpr extends IrNodeBase {
  node: "unary";
  op: UnaryOperator;
  operand: Expression;
  type: CanonicalType;
}

export interface BinaryExpr extends IrNodeBase {
  node: "binary";
  op: BinaryOperator;
  left: Expression;
  right: Expression;
  type: CanonicalType;
}

export interface ComparisonExpr extends IrNodeBase {
  node: "comparison";
  op: ComparisonOperator;
  left: Expression;
  right: Expression;
  type: CanonicalType;
}

export interface LogicalExpr extends IrNodeBase {
  node: "logical";
  op: LogicalOperator;
  left: Expression;
  right: Expression;
  type: CanonicalType;
}

export type ConversionSafety =
  | "identity"
  | "widening"
  | "narrowing"
  | "signedness_change"
  | "precision_loss"
  | "reinterpretation"
  | "vendor_defined"
  | "invalid";

export interface ConversionExpr extends IrNodeBase {
  node: "conversion";
  operand: Expression;
  from: CanonicalType;
  to: CanonicalType;
  safety: ConversionSafety;
  type: CanonicalType;
}

export interface FunctionCallExpr extends IrNodeBase {
  node: "function_call";
  name: string;
  args: Expression[];
  type: CanonicalType;
}

export interface FbInvokeExpr extends IrNodeBase {
  node: "fb_invoke";
  instance: string;
  namedArgs: { name: string; value: Expression }[];
  type: CanonicalType;
}

/** Reference to a timer/counter field (e.g. .DN, .ACC) — kept semantic. */
export interface InstanceFieldExpr extends IrNodeBase {
  node: "instance_field";
  instance: string;
  field: string;
  instanceKind: "timer" | "counter" | "fb" | "unknown";
  type: CanonicalType;
}

export interface HardwareRefExpr extends IrNodeBase {
  node: "hardware_ref";
  logicalName: string;
  type: CanonicalType;
}

export interface VendorExtensionExpr extends IrNodeBase {
  node: "vendor_extension";
  vendorName: string;
  rawArgs: string[];
  type: CanonicalType;
}

export interface UnresolvedExpr extends IrNodeBase {
  node: "unresolved_expr";
  raw: string;
  reason: string;
  type: CanonicalType;
}

export type Expression =
  | LiteralExpr
  | SymbolRefExpr
  | MemberAccessExpr
  | ArrayAccessExpr
  | UnaryExpr
  | BinaryExpr
  | ComparisonExpr
  | LogicalExpr
  | ConversionExpr
  | FunctionCallExpr
  | FbInvokeExpr
  | InstanceFieldExpr
  | HardwareRefExpr
  | VendorExtensionExpr
  | UnresolvedExpr;

export const EXPRESSION_NODE_KINDS = new Set<string>([
  "literal", "symbol_ref", "member_access", "array_access", "unary", "binary",
  "comparison", "logical", "conversion", "function_call", "fb_invoke",
  "instance_field", "hardware_ref", "vendor_extension", "unresolved_expr",
]);
