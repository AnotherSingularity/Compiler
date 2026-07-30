/**
 * Semantic analysis subsystem — barrel export.
 *
 * Operation normalization (vendor mnemonic → canonical semantic_operation) plus
 * the deterministic typed semantic core: scope/symbol resolution, canonical type
 * resolution over expressions, and explicit conversion-safety classification.
 */
export {
  normalizeProgramOperations,
  mnemonicRule,
} from "./operation-normalization";

export {
  Scope,
  buildProgramScope,
  buildRoutineScope,
  withLoopIndex,
  type SymbolEntry,
  type SymbolKind,
} from "./scopes";

export {
  isUnresolved,
  isInteger,
  isReal,
  isNumeric,
  typeEquals,
  arithmeticResultType,
} from "./types";

export { classifyConversion } from "./conversions";

export { resolveProgram } from "./resolver";
