/**
 * Canonical type model. Language-neutral; vendor spellings are recorded only in
 * `sourceSpelling`, never as the type identity.
 */

export type CanonicalTypeKind =
  | "boolean"
  | "integer"
  | "real"
  | "string"
  | "time"
  | "date"
  | "datetime"
  | "array"
  | "structure"
  | "enumeration"
  | "alias"
  | "function_block_instance"
  | "hardware_reference"
  | "opaque_vendor"
  | "unresolved";

export interface BooleanType {
  kind: "boolean";
  sourceSpelling?: string;
}

export interface IntegerType {
  kind: "integer";
  signed: boolean;
  /** Bit width (8/16/32/64). */
  bits: number;
  sourceSpelling?: string;
}

export interface RealType {
  kind: "real";
  /** 32 or 64 where known. */
  bits?: number;
  sourceSpelling?: string;
}

export interface StringType {
  kind: "string";
  /** Declared capacity (chars) where known. */
  capacity?: number;
  wide?: boolean;
  sourceSpelling?: string;
}

export interface TimeType {
  kind: "time";
  sourceSpelling?: string;
}
export interface DateType {
  kind: "date";
  sourceSpelling?: string;
}
export interface DateTimeType {
  kind: "datetime";
  sourceSpelling?: string;
}

export interface ArrayDimension {
  lower: number;
  upper: number;
  /** True if bounds were inferred rather than declared. */
  inferred: boolean;
}

export interface ArrayType {
  kind: "array";
  element: CanonicalType;
  dimensions: ArrayDimension[];
  sourceSpelling?: string;
}

export interface StructureMember {
  name: string;
  type: CanonicalType;
  hidden?: boolean;
  description?: string;
}

export interface StructureType {
  kind: "structure";
  name: string;
  members: StructureMember[];
  sourceSpelling?: string;
}

export interface EnumerationMember {
  name: string;
  value: number;
}
export interface EnumerationType {
  kind: "enumeration";
  name: string;
  members: EnumerationMember[];
  base?: IntegerType;
  sourceSpelling?: string;
}

export interface AliasType {
  kind: "alias";
  name: string;
  aliased: CanonicalType;
  sourceSpelling?: string;
}

export interface FunctionBlockInstanceType {
  kind: "function_block_instance";
  fbTypeName: string;
  sourceSpelling?: string;
}

export interface HardwareReferenceType {
  kind: "hardware_reference";
  /** Data type carried on the wire/point. */
  dataType?: CanonicalType;
  sourceSpelling?: string;
}

/** Isolated, non-portable vendor type. Marked unresolved for portability. */
export interface OpaqueVendorType {
  kind: "opaque_vendor";
  vendorName: string;
  language?: string;
  sourceSpelling?: string;
}

export interface UnresolvedType {
  kind: "unresolved";
  /** Best-effort name that could not be resolved. */
  name?: string;
  reason?: string;
  sourceSpelling?: string;
}

export type CanonicalType =
  | BooleanType
  | IntegerType
  | RealType
  | StringType
  | TimeType
  | DateType
  | DateTimeType
  | ArrayType
  | StructureType
  | EnumerationType
  | AliasType
  | FunctionBlockInstanceType
  | HardwareReferenceType
  | OpaqueVendorType
  | UnresolvedType;

// ── Constructors for the common primitives ────────────────────────────────
export const BOOL: BooleanType = { kind: "boolean" };
export const REAL32: RealType = { kind: "real", bits: 32 };
export const REAL64: RealType = { kind: "real", bits: 64 };
export function int(bits: number, signed = true, sourceSpelling?: string): IntegerType {
  return { kind: "integer", signed, bits, sourceSpelling };
}
export function unresolvedType(name?: string, reason?: string): UnresolvedType {
  return { kind: "unresolved", name, reason };
}

const CANONICAL_TYPE_KINDS = new Set<string>([
  "boolean", "integer", "real", "string", "time", "date", "datetime", "array",
  "structure", "enumeration", "alias", "function_block_instance",
  "hardware_reference", "opaque_vendor", "unresolved",
]);

export function isCanonicalTypeKind(k: string): k is CanonicalTypeKind {
  return CANONICAL_TYPE_KINDS.has(k);
}
