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
import type { MigrationExecutionSummary, SemanticLossRecord } from "../contracts/compile";
import { collectProgramLosses } from "../loss/records";
import { parseSTSourceWithDiagnostics, type ASTNode } from "../parser";
import { emitMEL } from "../emitter";
import { emitAB } from "../emitter-ab";
import { normalizeStProgram } from "../ir/normalize";
import { normalizeProgramOperations } from "../semantic/operation-normalization";
import { resolveProgram } from "../semantic/resolver";
import { applyCapabilityDispositions } from "../capability/evaluator";
import { manifestForTarget } from "../capability/manifests";
import { emitStatements, type StEmitTarget } from "../lowering/st-emitter";
import { emitDeclarations, declsAreCanonical } from "../lowering/st-decl-emitter";
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
}

/** Direction of the legacy emitter for a target language. */
function legacyEmit(target: LanguageId, nodes: ASTNode[], sourceLines: string[]): { output: string; diagnostics: unknown[] } {
  if (target === "mitsubishi-gx-st") return emitMEL(nodes, "<input>", sourceLines);
  return emitAB(nodes, "<input>", sourceLines);
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

  const resolved = resolveProgram(
    normalizeProgramOperations(normalizeStProgram("MAIN", rawAst, { sourceId: "<input>", language: sourceLanguage })),
  );
  // Authoritative capability pass: the target manifest re-stamps each semantic
  // operation's disposition (manifest-declared rules win; undeclared operations
  // keep their normalization disposition). This is what makes the manifest
  // authoritative rather than informational — loss records derive from it.
  const targetManifest = manifestForTarget(targetLanguage);
  const program = targetManifest ? applyCapabilityDispositions(resolved, targetManifest) : resolved;
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

  // ── Declarations (whole-block decision: primitives → canonical) ──────────
  const rawVarBlocks = rawAst.filter((n) => n.kind === "var_block");
  const locals = program.routines[0].locals;
  if (locals.length > 0) {
    if (reg.isActive("declarations") && declsAreCanonical(locals)) {
      outParts.push(emitDeclarations(locals, target).join("\n"));
      canonicalNodeCount += locals.length;
      canonicalSegmentCount++;
      for (const _ of locals) bump("declarations", "canonical");
    } else {
      outParts.push(legacyEmit(targetLanguage, rawVarBlocks, sourceLines).output);
      legacyNodeCount += locals.length;
      legacySegmentCount++;
      const fam: MigrationFamily = declsAreCanonical(locals) ? "declarations" : "arrays_structures";
      for (const _ of locals) bump(fam, "legacy");
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
      const emitted = legacyEmit(targetLanguage, nodes, sourceLines);
      outParts.push(emitted.output);
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
  };
}
