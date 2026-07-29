/**
 * Canonical declarations: variables, types, routines, functions, function blocks.
 */
import type { IrNodeBase } from "./nodes";
import type { CanonicalType } from "./types";
import type { Expression } from "./expressions";
import type { Statement } from "./statements";

export type VariableDirection = "input" | "output" | "in_out" | "local" | "global" | "external" | "temp";
export type StorageClass = "normal" | "retain" | "constant" | "non_retain";

export interface CanonicalVariableDeclaration extends IrNodeBase {
  node: "var_decl";
  name: string;
  type: CanonicalType;
  direction: VariableDirection;
  storage: StorageClass;
  initial: Expression | null;
  /** Direct-address / hardware binding (e.g. %IX0.0, M100) when declared. */
  address?: string;
  description?: string;
}

export interface CanonicalDataTypeDeclaration extends IrNodeBase {
  node: "type_decl";
  name: string;
  type: CanonicalType;
  description?: string;
}

export interface CanonicalParameter {
  name: string;
  type: CanonicalType;
  direction: VariableDirection;
  required?: boolean;
  description?: string;
}

export interface CanonicalRoutine extends IrNodeBase {
  node: "routine";
  name: string;
  locals: CanonicalVariableDeclaration[];
  body: Statement[];
  /** "st" | "ladder" — provenance of the original body language. */
  bodyOrigin: "st" | "ladder" | "mixed";
}

export interface CanonicalFunction extends IrNodeBase {
  node: "function";
  name: string;
  parameters: CanonicalParameter[];
  returnType: CanonicalType;
  locals: CanonicalVariableDeclaration[];
  body: Statement[];
}

export interface CanonicalFunctionBlock extends IrNodeBase {
  node: "function_block";
  name: string;
  parameters: CanonicalParameter[];
  locals: CanonicalVariableDeclaration[];
  body: Statement[];
  /** True when derived from a Rockwell AOI (provenance). */
  fromAoi?: boolean;
}

export const DECLARATION_NODE_KINDS = new Set<string>([
  "var_decl", "type_decl", "routine", "function", "function_block",
]);
