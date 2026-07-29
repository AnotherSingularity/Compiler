/**
 * IR structural + semantic validation → IR_* diagnostics.
 *
 * Walks the program graph once to collect node ids and referenced ids, then
 * reports duplicates, broken references, unknown node kinds, invalid spans,
 * missing types, invalid array bounds, and vendor-mnemonic-as-identity.
 */
import type { CompilerDiagnostic } from "../contracts/diagnostics";
import { IR_SCHEMA_VERSION, IR_SCHEMA_TAG } from "./version";
import { EXPRESSION_NODE_KINDS } from "./expressions";
import { STATEMENT_NODE_KINDS } from "./statements";
import { DECLARATION_NODE_KINDS } from "./declarations";
import { ALL_IR_OPERATION_KINDS, RESERVED_VENDOR_MNEMONICS } from "./operations";
import type { CanonicalProgram } from "./project";
import type { CanonicalIrEnvelope } from "./serialize";

const KNOWN_NODE_KINDS = new Set<string>([
  ...EXPRESSION_NODE_KINDS,
  ...STATEMENT_NODE_KINDS,
  ...DECLARATION_NODE_KINDS,
  "program", "resource", "task", "io_point",
]);

const IR_OP_KINDS = new Set<string>(ALL_IR_OPERATION_KINDS);

function diag(code: string, message: string, relatedEntity?: string): CompilerDiagnostic {
  return { code, severity: "error", message, stage: "ir", relatedEntity, reviewRequired: true };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function validateProgram(program: CanonicalProgram): CompilerDiagnostic[] {
  const diags: CompilerDiagnostic[] = [];
  const ids = new Set<string>();
  const referencedIds: string[] = [];

  function walk(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (!isRecord(value)) return;

    // Array-type bounds (types use `kind`, not `node`).
    if (value.kind === "array" && Array.isArray(value.dimensions)) {
      for (const d of value.dimensions as Array<Record<string, unknown>>) {
        if (typeof d.lower === "number" && typeof d.upper === "number" && d.upper < d.lower) {
          diags.push(diag("IR_INVALID_ARRAY_BOUNDS", `array bound lower ${d.lower} > upper ${d.upper} at ${path}`));
        }
      }
    }

    // Is this an IR node? (has string id + string node)
    if (typeof value.node === "string" && typeof value.id === "string") {
      const id = value.id as string;
      const kind = value.node as string;

      if (ids.has(id)) diags.push(diag("IR_DUPLICATE_ID", `duplicate node id ${id} at ${path}`, id));
      ids.add(id);

      if (!KNOWN_NODE_KINDS.has(kind)) {
        diags.push(diag("IR_UNKNOWN_NODE", `unknown node kind "${kind}" at ${path}`, id));
      }

      // Provenance + span.
      const origin = value.origin;
      if (!isRecord(origin)) {
        diags.push(diag("IR_MISSING_ORIGIN", `node ${id} missing origin at ${path}`, id));
      } else if (origin.kind === "source") {
        const span = origin.span as Record<string, unknown> | undefined;
        const start = span?.start as Record<string, unknown> | undefined;
        const end = span?.end as Record<string, unknown> | undefined;
        if (!start || !end || typeof start.line !== "number" || typeof end.line !== "number" || start.line < 1 || end.line < 1) {
          diags.push(diag("IR_INVALID_SPAN", `node ${id} has an invalid source span at ${path}`, id));
        } else if (end.line < start.line) {
          diags.push(diag("IR_INVALID_SPAN", `node ${id} span end line < start line at ${path}`, id));
        }
      } else if (origin.kind === "synthetic") {
        for (const ref of (origin.derivedFrom as string[] | undefined) ?? []) referencedIds.push(ref);
      }

      // Expressions must carry a type.
      if (EXPRESSION_NODE_KINDS.has(kind)) {
        const type = value.type as Record<string, unknown> | undefined;
        if (!type || typeof type.kind !== "string") {
          diags.push(diag("IR_MISSING_TYPE", `expression ${id} (${kind}) has no resolved type at ${path}`, id));
        }
      }

      // Semantic operation must use a canonical identity, never a vendor mnemonic.
      if (kind === "semantic_operation") {
        const op = value.operation as string | undefined;
        if (typeof op === "string") {
          if (RESERVED_VENDOR_MNEMONICS.has(op)) {
            diags.push(diag("IR_VENDOR_MNEMONIC_AS_IDENTITY", `semantic_operation ${id} uses vendor mnemonic "${op}" as identity at ${path}`, id));
          } else if (!IR_OP_KINDS.has(op)) {
            diags.push(diag("IR_UNKNOWN_OPERATION", `semantic_operation ${id} has unknown operation "${op}" at ${path}`, id));
          }
        } else {
          diags.push(diag("IR_UNKNOWN_OPERATION", `semantic_operation ${id} has no operation kind at ${path}`, id));
        }
      }
    }

    for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
  }

  walk(program, "$");

  // Broken-reference check: synthetic derivedFrom ids must exist.
  for (const ref of referencedIds) {
    if (!ids.has(ref)) diags.push(diag("IR_BROKEN_REFERENCE", `synthetic node references missing id ${ref}`, ref));
  }
  return diags;
}

export function validateEnvelope(env: CanonicalIrEnvelope): CompilerDiagnostic[] {
  const diags: CompilerDiagnostic[] = [];
  if (env.schema !== IR_SCHEMA_TAG) {
    diags.push(diag("IR_INVALID_SCHEMA_TAG", `expected schema "${IR_SCHEMA_TAG}", got "${String(env.schema)}"`));
  }
  if (env.schemaVersion !== IR_SCHEMA_VERSION) {
    diags.push(diag("IR_INVALID_SCHEMA_VERSION", `expected schema version ${IR_SCHEMA_VERSION}, got ${String(env.schemaVersion)}`));
  }
  if (env.program) diags.push(...validateProgram(env.program));
  else diags.push(diag("IR_MISSING_PROGRAM", "envelope has no program"));
  return diags;
}
