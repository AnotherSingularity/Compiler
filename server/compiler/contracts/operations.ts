/**
 * Canonical semantic operation + type kinds (invariant C).
 *
 * These name *behavioral meaning*, independent of vendor spelling. Vendor
 * mnemonics (TON, RTO, CTU, COP, CPS, BMOV, MVM, LIM, ...) map ONTO these in
 * frontend/backend tables — they never appear as canonical identities here.
 */

export type SemanticOperationKind =
  // control / data flow
  | "Assignment"
  | "ConditionalBranch"
  | "CaseSelection"
  | "ForLoop"
  | "WhileLoop"
  | "RepeatUntil"
  | "Return"
  | "Exit"
  // calls
  | "FunctionCall"
  | "FunctionBlockInvoke"
  | "ProgramCall"
  // timers / counters
  | "TimerOnDelay"
  | "TimerOffDelay"
  | "TimerRetentive"
  | "CounterUp"
  | "CounterDown"
  | "CounterReset"
  // data movement
  | "BlockCopy"
  | "SynchronousBlockCopy"
  | "MaskedMove"
  | "Fill"
  // hardware / io
  | "ReadInput"
  | "WriteOutput"
  // domain-specific (typically unsupported/manual-port on cross-vendor)
  | "PIDControl"
  | "MessageTransfer"
  | "MotionCommand"
  // escape hatches (invariant D)
  | "VendorExtension"
  | "UnsupportedOperation";

export const ALL_SEMANTIC_OPERATION_KINDS: readonly SemanticOperationKind[] = [
  "Assignment", "ConditionalBranch", "CaseSelection", "ForLoop", "WhileLoop",
  "RepeatUntil", "Return", "Exit", "FunctionCall", "FunctionBlockInvoke",
  "ProgramCall", "TimerOnDelay", "TimerOffDelay", "TimerRetentive", "CounterUp",
  "CounterDown", "CounterReset", "BlockCopy", "SynchronousBlockCopy", "MaskedMove",
  "Fill", "ReadInput", "WriteOutput", "PIDControl", "MessageTransfer",
  "MotionCommand", "VendorExtension", "UnsupportedOperation",
] as const;

export type CanonicalTypeKind =
  | "Boolean"
  | "Integer"
  | "UnsignedInteger"
  | "Float"
  | "String"
  | "Time"
  | "DateTime"
  | "Array"
  | "Struct"
  | "Enum"
  | "Alias"
  | "FunctionBlockInstance"
  | "OpaqueVendorType"
  | "Unresolved";

export const ALL_CANONICAL_TYPE_KINDS: readonly CanonicalTypeKind[] = [
  "Boolean", "Integer", "UnsignedInteger", "Float", "String", "Time", "DateTime",
  "Array", "Struct", "Enum", "Alias", "FunctionBlockInstance", "OpaqueVendorType",
  "Unresolved",
] as const;

/** Project-level features a backend may or may not support. */
export type ProjectFeatureKind =
  | "MultipleRoutines"
  | "GlobalTags"
  | "UserDefinedTypes"
  | "FunctionBlockDefinitions"
  | "Tasks"
  | "HardwareModules"
  | "IoMapping"
  | "CallGraph";

export const ALL_PROJECT_FEATURE_KINDS: readonly ProjectFeatureKind[] = [
  "MultipleRoutines", "GlobalTags", "UserDefinedTypes", "FunctionBlockDefinitions",
  "Tasks", "HardwareModules", "IoMapping", "CallGraph",
] as const;
