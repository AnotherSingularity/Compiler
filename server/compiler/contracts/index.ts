/**
 * Public compiler contracts — barrel export.
 *
 * Import from "./contracts" rather than reaching into individual files, so the
 * contract surface stays stable as internals move.
 */
export * from "./ids";
export * from "./source";
export * from "./diagnostics";
export * from "./compile";
export * from "./hash";
export * from "./operations";
export * from "./capability";
export * from "./ir";
export * from "./plugin";
export { COMPILER_VERSION, IR_SCHEMA_VERSION } from "../version";
