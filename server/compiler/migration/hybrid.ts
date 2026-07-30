/**
 * Mixed-program (hybrid) routing.
 *
 * Replaces whole-program fallback with per-statement routing: each top-level
 * statement is emitted by the canonical backend if its family is
 * canonical-active (and its expressions are canonically emittable), otherwise by
 * the legacy engine. Canonical-active statements stay canonical even when
 * adjacent to legacy-only statements (invariant: no silent family-level
 * fallback).
 *
 * Legacy fragments are produced by calling the real legacy emitter
 * (`emitMEL`/`emitAB`) on the ORIGINAL AST subset for that run — NOT by
 * reconstructing source, and NOT by regex-splicing whole-program output. The
 * final artifact is assembled deterministically, preserving statement order.
 */
import type { LanguageId } from "../contracts/ids";
import type { CompilerDiagnostic } from "../contracts/diagnostics";
import { fromLegacySeverity } from "../contracts/diagnostics";
import { lineSpan } from "../contracts/source";
import type { MigrationExecutionSummary, SemanticLossRecord } from "../contracts/compile";
import { collectProgramLosses } from "../loss/records";
import { parseSTSourceWithDiagnostics, type ASTNode } from "../parser";
import { emitMEL } from "../emitter";
import { emitAB } from "../emitter-ab";
import { buildSemanticProgram } from "../semantic/pipeline";
import { emitStatements, type StEmitTarget } from "../lowering/st-emitter";
import { emitDeclarations, declsAreCanonical, declFamilyOf } from "../lowering/st-decl-emitter";
import {
  MigrationRegistry,
  defaultRegistry,
  familyOfStatement,
  statementFullyCanonical,
  type MigrationFamily,
} from "./families";

type Engine = "canonical" | "legacy";

export interface HybridResult {
  output: string;
  diagnostics: CompilerDiagnostic[];
  canonicalNodeCount: number;
  legacyNodeCount: number;
  canonicalSegmentCount: number;
  legacySegmentCount: number;
  summary: MigrationExecutionSummary;
  familyExecution: Record<string, { canonical: number; legacy: number }>;
  outputLines: number;
  /** Structured semantic-loss records for the whole program (authoritative). */
  losses: SemanticLossRecord[];
  /** Memory-map (hardware_mapping family) + labels (project_metadata) — legacy-produced aux. */
  mappingYaml: string;
  labelsCsv: string;
}

interface LegacyEmitFull { output: string; diagnostics: unknown[]; mappingYaml: string; labelsCsv: string; translatedNodes: number }

/** Direction of the legacy emitter for a target language (full result incl. mapping/labels). */
function legacyEmitFull(target: LanguageId, nodes: ASTNode[], sourceLines: string[]): LegacyEmitFull {
  if (target === "mitsubishi-gx-st") return emitMEL(nodes, "<input>", sourceLines);
  return emitAB(nodes, "<input>", sourceLines);
}

/**
 * Per-fragment legacy emission for an explicitly legacy-only run. Receives the
 * exact AST subset and source lines; returns only the emitted text. This is the
 * ONLY legacy path ordinary compilation uses (it never calls the whole-program
 * oracle).
 */
export function emitLegacyFragment(target: LanguageId, nodes: ASTNode[], sourceLines: string[]): { output: string; diagnostics: unknown[] } {
  const r = legacyEmitFull(target, nodes, sourceLines);
  return { output: r.output, diagnostics: r.diagnostics };
}

export function isHybridEligibleSource(lang: LanguageId): boolean {
  return lang === "rockwell-logix-st" || lang === "mitsubishi-gx-st" || lang === "iec-61131-3-st";
}

/**
 * Compile a pure-ST program through mixed canonical/legacy routing.
 * Returns null on a parse error or a raw/canonical alignment mismatch (the
 * caller then uses the whole-program legacy path).
 */
export function compileHybrid(
  source: string,
  sourceLanguage: LanguageId,
  targetLanguage: LanguageId,
  reg: MigrationRegistry = defaultRegistry(),
): HybridResult | null {
  if (!isHybridEligibleSource(sourceLanguage)) return null;
  const parsed = parseSTSourceWithDiagnostics(source);
  if (parsed.partial) return null;
  const sourceLines = source.split("\n");
  const rawAst = parsed.ast;

  // Full semantic pipeline (normalize → resolve → conversion-lower → capability).
  // The capability pass makes the target manifest authoritative; loss records
  // derive from the re-stamped dispositions.
  const program = buildSemanticProgram(rawAst, sourceLanguage, targetLanguage);
  const canonicalBody = program.routines[0].body;
  const rawBody = rawAst.filter((n) => n.kind !== "var_block" && n.kind !== "comment");
  if (rawBody.length !== canonicalBody.length) return null; // alignment safety

  const target: StEmitTarget = { language: targetLanguage };
  const outParts: string[] = [];
  const diagnostics: CompilerDiagnostic[] = [];
  const familyExecution: Record<string, { canonical: number; legacy: number }> = {};
  const bump = (fam: MigrationFamily, engine: Engine) => {
    (familyExecution[fam] ??= { canonical: 0, legacy: 0 })[engine]++;
  };
  let canonicalNodeCount = 0;
  let legacyNodeCount = 0;
  let canonicalSegmentCount = 0;
  let legacySegmentCount = 0;

  // ── Declarations (whole-block decision: every decl's family must be active) ─
  const isActive = (f: MigrationFamily) => reg.isActive(f);
  const rawVarBlocks = rawAst.filter((n) => n.kind === "var_block");
  const locals = program.routines[0].locals;
  if (locals.length > 0) {
    if (declsAreCanonical(locals, isActive)) {
      outParts.push(emitDeclarations(locals, target).join("\n"));
      canonicalNodeCount += locals.length;
      canonicalSegmentCount++;
      for (const d of locals) bump(declFamilyOf(d.type) ?? "declarations", "canonical");
    } else {
      outParts.push(emitLegacyFragment(targetLanguage, rawVarBlocks, sourceLines).output);
      legacyNodeCount += locals.length;
      legacySegmentCount++;
      for (const d of locals) bump(declFamilyOf(d.type) ?? "arrays_structures", "legacy");
    }
  }

  // ── Body statements: per-statement routing, grouped into runs ────────────
  const engineOf = (i: number): { engine: Engine; family: MigrationFamily } => {
    const stmt = canonicalBody[i];
    const family = familyOfStatement(stmt);
    // The WHOLE subtree must be canonically emittable; a control-flow statement
    // containing a legacy-only node (e.g. a timer) is structurally inseparable
    // and routes to legacy as a unit.
    const engine: Engine = statementFullyCanonical(stmt, (f) => reg.isActive(f)) ? "canonical" : "legacy";
    return { engine, family };
  };

  let i = 0;
  while (i < canonicalBody.length) {
    const { engine } = engineOf(i);
    let j = i;
    while (j < canonicalBody.length && engineOf(j).engine === engine) j++;
    // run [i, j)
    if (engine === "canonical") {
      outParts.push(emitStatements(canonicalBody.slice(i, j), target, "").join("\n"));
      canonicalSegmentCount++;
      for (let k = i; k < j; k++) { canonicalNodeCount++; bump(engineOf(k).family, "canonical"); }
    } else {
      const nodes = rawBody.slice(i, j);
      const emitted = emitLegacyFragment(targetLanguage, nodes, sourceLines);
      outParts.push(emitted.output);
      // Propagate the legacy fragment's own diagnostics (e.g. MANUAL PORT for an
      // untranslatable instruction) — never silently drop them.
      for (const d of emitted.diagnostics as Array<{ severity: string; code: string; message: string; line: number }>) {
        diagnostics.push({
          code: d.code, severity: fromLegacySeverity(d.severity), message: d.message,
          stage: "emit", language: targetLanguage,
          ...(d.line > 0 ? { span: lineSpan("<input>", d.line) } : {}),
        });
      }
      legacySegmentCount++;
      for (let k = i; k < j; k++) { legacyNodeCount++; bump(engineOf(k).family, "legacy"); }
    }
    i = j;
  }

  const output = outParts.filter((p) => p !== "").join("\n");
  const engineLabel: "canonical" | "legacy" | "mixed" =
    canonicalNodeCount > 0 && legacyNodeCount > 0 ? "mixed" : canonicalNodeCount > 0 ? "canonical" : "legacy";

  diagnostics.push({
    code: "MIGRATION_HYBRID_ROUTING",
    severity: "info",
    message: `Hybrid routing: ${canonicalNodeCount} canonical node(s) in ${canonicalSegmentCount} segment(s), ${legacyNodeCount} legacy node(s) in ${legacySegmentCount} segment(s).`,
    stage: "lowering",
    language: targetLanguage,
  });

  const summary: MigrationExecutionSummary = {
    familyStatuses: Object.fromEntries(Object.keys(familyExecution).map((f) => [f, reg.get(f as MigrationFamily)])),
    canonicalNodeCount,
    legacyNodeCount,
    fallbackCount: 0,
    shadowComparisonCount: 0,
    approvedDifferenceCount: 0,
    unapprovedDifferenceCount: 0,
    engine: engineLabel,
  };

  const losses = collectProgramLosses(program, { sourceLanguage, targetLanguage });

  // Memory-map + labels are legacy-family (hardware_mapping / project_metadata)
  // artifacts. Produce them from the legacy allocator COMPONENT on the full AST
  // (not the whole-program oracle) so the canonical/mixed result carries the same
  // auxiliary artifacts the public API expects.
  const aux = legacyEmitFull(targetLanguage, rawAst, sourceLines);

  return {
    output,
    diagnostics,
    canonicalNodeCount,
    legacyNodeCount,
    canonicalSegmentCount,
    legacySegmentCount,
    summary,
    familyExecution,
    outputLines: output === "" ? 0 : output.split("\n").length,
    losses,
    mappingYaml: aux.mappingYaml,
    labelsCsv: aux.labelsCsv,
  };
}
