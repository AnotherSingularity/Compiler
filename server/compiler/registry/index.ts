/**
 * Registry subsystem — barrel export.
 */
export { LanguageRegistry, RegistryError } from "./registry";
export type { DetectionCandidate, DetectionOutcome } from "./registry";
export { compileWithRegistry } from "./orchestrator";
export { createDefaultRegistry, defaultRegistry } from "./default-registry";
