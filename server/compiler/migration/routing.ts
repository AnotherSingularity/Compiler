/**
 * Migration routing.
 *
 * Decides whether the canonical pipeline can fully handle a program (every
 * statement in a `canonical_active` family, every expression emittable by the
 * canonical emitter, and no declarations unless that family is active). If so,
 * `compile()` returns canonical output for it; otherwise the legacy engine
 * handles the whole program (a `canonical_active` family never *silently* falls
 * back — the migration summary + a diagnostic make the routing visible).
 */
import type { LanguageId } from "../contracts/ids";
import type { CompilerDiagnostic } from "../contracts/diagnostics";
import type { GeneratedArtifact, MigrationExecutionSummary } from "../contracts/compile";
import type { CanonicalProgram } from "../ir/project";
import type { Expression } from "../ir/expressions";
import type { Statement } from "../ir/statements";
import { parseSTSourceWithDiagnostics } from "../parser";
import { normalizeStProgram } from "../ir/normalize";
import { normalizeProgramOperations } from "../semantic/operation-normalization";
import { emitRoutineBody, type StEmitTarget } from "../lowering/st-emitter";
import {
  MigrationRegistry,
  defaultRegistry,
  familyOfStatement,
  expressionFullyCanonical,
  type MigrationFamily,
} from "./families";

interface Coverage {
  covered: boolean;
  canonicalNodeCount: number;
  legacyNodeCount: number;
  families: Set<MigrationFamily>;
  reasons: string[];
}

function statementExpressions(stmt: Statement): Expression[] {
  switch (stmt.node) {
    case "assignment": return [stmt.target, stmt.value];
    case "conditional": return stmt.branches.map((b) => b.condition);
    case "case": return [stmt.selector, ...stmt.branches.flatMap((b) => b.labels)];
    case "for": return [stmt.from, stmt.to, ...(stmt.by ? [stmt.by] : [])];
    case "while": return [stmt.condition];
    case "repeat": return [stmt.until];
    default: return [];
  }
}

function childStatements(stmt: Statement): Statement[] {
  switch (stmt.node) {
    case "conditional": return [...stmt.branches.flatMap((b) => b.body), ...(stmt.elseBody ?? [])];
    case "case": return [...stmt.branches.flatMap((b) => b.body), ...(stmt.elseBody ?? [])];
    case "for":
    case "while":
    case "repeat": return stmt.body;
    default: return [];
  }
}

function analyze(program: CanonicalProgram, reg: MigrationRegistry): Coverage {
  const families = new Set<MigrationFamily>();
  const reasons: string[] = [];
  let canonicalNodeCount = 0;
  let legacyNodeCount = 0;
  let covered = true;

  // Declarations family gates any locals/globals.
  const hasDecls = program.globals.length > 0 || program.routines.some((r) => r.locals.length > 0);
  if (hasDecls) {
    families.add("declarations");
    if (!reg.isActive("declarations")) { covered = false; reasons.push("declarations not canonical_active"); }
  }

  const walk = (stmt: Statement): void => {
    const fam = familyOfStatement(stmt);
    families.add(fam);
    const exprsOk = statementExpressions(stmt).every(expressionFullyCanonical);
    if (!exprsOk) { families.add("expressions"); }
    if (reg.isActive(fam) && exprsOk) canonicalNodeCount++;
    else {
      legacyNodeCount++;
      covered = false;
      if (!reg.isActive(fam)) reasons.push(`${fam} not canonical_active`);
      else reasons.push(`expression not canonical in ${fam}`);
    }
    childStatements(stmt).forEach(walk);
  };
  for (const r of program.routines) r.body.forEach(walk);

  return { covered, canonicalNodeCount, legacyNodeCount, families, reasons };
}

export interface CanonicalCompileOutput {
  artifacts: GeneratedArtifact[];
  diagnostics: CompilerDiagnostic[];
  translatedNodes: number;
  summary: MigrationExecutionSummary;
  outputLines: number;
}

/** Only pure ST source languages are eligible; L5K/project sources are not. */
export function isCanonicalEligibleSource(lang: LanguageId): boolean {
  return lang === "rockwell-logix-st" || lang === "mitsubishi-gx-st" || lang === "iec-61131-3-st";
}

/**
 * Try to compile a pure-ST program through the canonical path. Returns null if
 * the program is not fully covered by active families (caller uses legacy).
 */
export function tryCanonicalCompile(
  source: string,
  sourceLanguage: LanguageId,
  targetLanguage: LanguageId,
  reg: MigrationRegistry = defaultRegistry(),
): CanonicalCompileOutput | null {
  if (!isCanonicalEligibleSource(sourceLanguage)) return null;
  const parsed = parseSTSourceWithDiagnostics(source);
  if (parsed.partial) return null; // parse errors → legacy path handles reporting
  const program = normalizeProgramOperations(normalizeStProgram("MAIN", parsed.ast, { sourceId: "<input>", language: sourceLanguage }));
  const cov = analyze(program, reg);
  if (!cov.covered) return null;

  const target: StEmitTarget = { language: targetLanguage };
  const body = program.routines.map((r) => emitRoutineBody(r, target)).join("\n");
  const outputLines = body === "" ? 0 : body.split("\n").length;
  const familyStatuses: Record<string, string> = {};
  for (const f of cov.families) familyStatuses[f] = reg.get(f);

  const summary: MigrationExecutionSummary = {
    familyStatuses,
    canonicalNodeCount: cov.canonicalNodeCount,
    legacyNodeCount: 0,
    fallbackCount: 0,
    shadowComparisonCount: 0,
    approvedDifferenceCount: 0,
    unapprovedDifferenceCount: 0,
    engine: "canonical",
  };

  const diagnostics: CompilerDiagnostic[] = [
    {
      code: "MIGRATION_CANONICAL_PATH",
      severity: "info",
      message: `Compiled via canonical pipeline (families: ${[...cov.families].sort().join(", ")}; ${cov.canonicalNodeCount} node(s)).`,
      stage: "lowering",
      language: targetLanguage,
    },
  ];

  return {
    artifacts: [{ kind: "structured_text", language: targetLanguage, name: "output.st", content: body }],
    diagnostics,
    translatedNodes: cov.canonicalNodeCount,
    summary,
    outputLines,
  };
}
