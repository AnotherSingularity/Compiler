import { describe, it, expect } from "vitest";
import { PARITY_FIXTURES } from "../../../server/compiler/migration/fixtures";
import { PARITY_APPROVALS } from "../../../server/compiler/migration/approvals";
import { runParity, unapprovedRows } from "../../../server/compiler/migration/parity";

describe("Stage 3 — legacy parity", () => {
  const rows = runParity(PARITY_FIXTURES, PARITY_APPROVALS);

  it("every fixture routes through the canonical path", () => {
    for (const r of rows) expect(r.routedCanonical).toBe(true);
  });

  it("has zero unapproved differences", () => {
    const bad = unapprovedRows(rows);
    expect(bad.map((r) => `${r.fixtureId}/${r.direction}: ${r.note}`)).toEqual([]);
  });

  it("every difference is classified (identical or an approved classification)", () => {
    for (const r of rows) {
      expect(["identical", "canonical_improvement", "format_only", "bug_fix", "additional_diagnostic", "semantic_loss_now_explicit", "intentional_behavior_change"]).toContain(r.classification);
    }
  });

  it("fails if an approval's pinned hashes drift (regression guard)", () => {
    const tampered = PARITY_APPROVALS.map((a, i) => (i === 0 ? { ...a, expectedCanonicalHash: "deadbeef" } : a));
    const bad = unapprovedRows(runParity(PARITY_FIXTURES, tampered));
    expect(bad.length).toBeGreaterThan(0);
  });
});
