/**
 * Legacy-parity harness.
 *
 * For each family fixture, compare the canonical pipeline output against the
 * legacy engine (`translate`, used here strictly as a parity oracle). Every
 * difference must be either `identical` or covered by a version-controlled
 * ParityApproval; an unapproved difference fails the harness.
 */
import { createHash } from "crypto";
import { translateLegacyForParity } from "../../translate";
import type { LanguageId } from "../contracts/ids";
import { tryCanonicalCompile } from "./routing";

export type ParityDifferenceClassification =
  | "identical"
  | "format_only"
  | "canonical_improvement"
  | "bug_fix"
  | "additional_diagnostic"
  | "semantic_loss_now_explicit"
  | "intentional_behavior_change"
  | "unapproved";

export interface ParityApproval {
  fixtureId: string;
  sourceLanguage: LanguageId;
  targetLanguage: LanguageId;
  family: string;
  classification: Exclude<ParityDifferenceClassification, "identical" | "unapproved">;
  reason: string;
  expectedLegacyHash: string;
  expectedCanonicalHash: string;
}

export interface ParityFixture {
  id: string;
  direction: "ab2mel" | "mel2ab";
  family: string;
  source: string;
}

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function languages(direction: "ab2mel" | "mel2ab"): { src: LanguageId; tgt: LanguageId } {
  return direction === "ab2mel"
    ? { src: "rockwell-logix-st", tgt: "mitsubishi-gx-st" }
    : { src: "mitsubishi-gx-st", tgt: "rockwell-logix-st" };
}

export interface ParityRow {
  fixtureId: string;
  direction: string;
  family: string;
  legacyHash: string;
  canonicalHash: string;
  routedCanonical: boolean;
  classification: ParityDifferenceClassification;
  approved: boolean;
  note: string;
}

export function runParity(fixtures: ParityFixture[], approvals: ParityApproval[]): ParityRow[] {
  const rows: ParityRow[] = [];
  for (const f of fixtures) {
    const { src, tgt } = languages(f.direction);
    const legacy = translateLegacyForParity(f.source, f.direction).output;
    const canonical = tryCanonicalCompile(f.source, src, tgt);
    const legacyHash = sha(legacy);
    const canonicalHash = canonical ? sha(canonical.artifacts.find((a) => a.name === "output.st")!.content) : "<not-canonical>";
    const routedCanonical = canonical !== null;

    if (!routedCanonical) {
      rows.push({ fixtureId: f.id, direction: f.direction, family: f.family, legacyHash, canonicalHash, routedCanonical, classification: "unapproved", approved: false, note: "fixture did not route through the canonical path (expected canonical-active family coverage)" });
      continue;
    }
    if (legacyHash === canonicalHash) {
      rows.push({ fixtureId: f.id, direction: f.direction, family: f.family, legacyHash, canonicalHash, routedCanonical, classification: "identical", approved: true, note: "byte-identical to legacy" });
      continue;
    }
    const approval = approvals.find((a) => a.fixtureId === f.id && a.sourceLanguage === src && a.targetLanguage === tgt);
    if (!approval) {
      rows.push({ fixtureId: f.id, direction: f.direction, family: f.family, legacyHash, canonicalHash, routedCanonical, classification: "unapproved", approved: false, note: "difference has no approval record" });
      continue;
    }
    if (approval.expectedLegacyHash !== legacyHash || approval.expectedCanonicalHash !== canonicalHash) {
      rows.push({ fixtureId: f.id, direction: f.direction, family: f.family, legacyHash, canonicalHash, routedCanonical, classification: "unapproved", approved: false, note: "approval hashes no longer match current output" });
      continue;
    }
    rows.push({ fixtureId: f.id, direction: f.direction, family: f.family, legacyHash, canonicalHash, routedCanonical, classification: approval.classification, approved: true, note: approval.reason });
  }
  return rows;
}

export function unapprovedRows(rows: ParityRow[]): ParityRow[] {
  return rows.filter((r) => !r.approved);
}
