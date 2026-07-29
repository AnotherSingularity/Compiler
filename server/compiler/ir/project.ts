/**
 * Canonical program + project structure (resources, tasks, hardware, program).
 * The full project linker lives in Stage 5; these are the data shapes.
 */
import type { IrNodeBase } from "./nodes";
import type { LanguageId } from "../contracts/ids";
import type { CanonicalType } from "./types";
import type {
  CanonicalVariableDeclaration,
  CanonicalDataTypeDeclaration,
  CanonicalRoutine,
  CanonicalFunction,
  CanonicalFunctionBlock,
} from "./declarations";

export type TaskKind = "continuous" | "periodic" | "event" | "unknown";

export interface CanonicalTask extends IrNodeBase {
  node: "task";
  name: string;
  taskKind: TaskKind;
  priority?: number;
  periodMs?: number;
  watchdogMs?: number;
  /** Program names scheduled by this task, in order. */
  programs: string[];
}

export interface CanonicalIoPoint extends IrNodeBase {
  node: "io_point";
  direction: "input" | "output" | "bidirectional";
  dataType: CanonicalType;
  logicalName: string;
  sourceAddress?: string;
  moduleRef?: string;
  channel?: string;
  safetyClass?: string;
  /** Unresolved target binding requirement (never a guessed address). */
  targetBindingResolved: boolean;
}

export interface CanonicalResource extends IrNodeBase {
  node: "resource";
  name: string;
  /** Controller catalog / processor type where known. */
  controllerType?: string;
  tasks: CanonicalTask[];
  io: CanonicalIoPoint[];
}

export interface CanonicalProgramMetadata {
  /** Controller/project name from the source. */
  controllerName?: string;
  /** Source project version (e.g. L5K IE_VER). */
  sourceVersion?: string;
  /** True if any part of this program is partial/degraded. */
  partial: boolean;
  notes?: string[];
}

export interface CanonicalProgram extends IrNodeBase {
  node: "program";
  name: string;
  /** Every source language that contributed to this program. */
  languageOrigins: LanguageId[];
  dataTypes: CanonicalDataTypeDeclaration[];
  globals: CanonicalVariableDeclaration[];
  resources: CanonicalResource[];
  routines: CanonicalRoutine[];
  functions: CanonicalFunction[];
  functionBlocks: CanonicalFunctionBlock[];
  metadata: CanonicalProgramMetadata;
}
