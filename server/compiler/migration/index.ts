/**
 * Incremental migration subsystem — barrel export.
 */
export {
  MigrationRegistry,
  defaultRegistry,
  DEFAULT_FAMILY_STATUS,
  familyOfStatement,
  expressionFullyCanonical,
  type MigrationFamily,
  type MigrationStatus,
} from "./families";
export {
  tryCanonicalCompile,
  isCanonicalEligibleSource,
  type CanonicalCompileOutput,
} from "./routing";
