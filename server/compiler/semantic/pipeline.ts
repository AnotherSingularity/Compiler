/**
 * Semantic pipeline — the single, ordered production path from a parsed ST AST
 * to a fully-analyzed canonical program.
 *
 * Pass order is explicit and deterministic:
 *   normalize (AST → IR)
 *     → operation normalization (vendor mnemonic → semantic_operation)
 *     → symbol/type resolution (scopes, declared types, expression typing)
 *     → conversion lowering (TYPE_TO_TYPE calls → conversion nodes)
 *     → capability evaluation (target manifest re-stamps dispositions)
 *
 * Both the production router (`migration/hybrid.ts`) and the parity oracle path
 * (`migration/routing.ts`) call this so they can never diverge in how a program
 * is analyzed.
 */
import type { LanguageId } from "../contracts/ids";
import type { CanonicalProgram } from "../ir/project";
import { normalizeStProgram } from "../ir/normalize";
import { normalizeProgramOperations } from "./operation-normalization";
import { resolveProgram } from "./resolver";
import { lowerConversions } from "./conversion-lowering";
import { lowerInstanceFields } from "./instance-members";
import { applyCapabilityDispositions } from "../capability/evaluator";
import { manifestForTarget } from "../capability/manifests";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ast = any;

/**
 * Build a fully-analyzed canonical program from a parsed ST AST. Pure and
 * deterministic; the same (ast, source, target) always yields identical ids,
 * types, and dispositions regardless of construction order.
 */
export function buildSemanticProgram(
  ast: Ast[],
  sourceLanguage: LanguageId,
  targetLanguage: LanguageId,
  programName = "MAIN",
): CanonicalProgram {
  const normalized = normalizeProgramOperations(
    normalizeStProgram(programName, ast, { sourceId: "<input>", language: sourceLanguage }),
  );
  const resolved = resolveProgram(normalized);
  const converted = lowerConversions(resolved);
  // Timer/counter instance fields + type-aware RES (needs the target dialect for
  // field spelling and the resolved operations for instance detection).
  const withInstances = lowerInstanceFields(converted, targetLanguage);
  const manifest = manifestForTarget(targetLanguage);
  return manifest ? applyCapabilityDispositions(withInstances, manifest) : withInstances;
}
