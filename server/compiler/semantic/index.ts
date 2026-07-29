/**
 * Semantic analysis subsystem — barrel export.
 *
 * Stage 2 in progress: operation normalization is implemented. Scope/symbol/
 * type resolution, conversion classification, and the parser-recovery
 * correction are the remaining Stage 2 work (see docs/BUILDOUT_STATUS.md).
 */
export {
  normalizeProgramOperations,
  mnemonicRule,
} from "./operation-normalization";
