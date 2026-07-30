import { describe, it, expect } from "vitest";
import { compileLegacy } from "../../../server/compiler/compat/legacy-adapter";
import { collectProgramLosses, completenessFromLosses } from "../../../server/compiler/loss/records";
import { normalizeStProgram } from "../../../server/compiler/ir/normalize";
import { normalizeProgramOperations } from "../../../server/compiler/semantic/operation-normalization";
import { parseSTSourceWithDiagnostics } from "../../../server/compiler/parser";

function losses(src: string) {
  const program = normalizeProgramOperations(
    normalizeStProgram("MAIN", parseSTSourceWithDiagnostics(src).ast, { sourceId: "<t>", language: "rockwell-logix-st" }),
  );
  return collectProgramLosses(program, { sourceLanguage: "rockwell-logix-st", targetLanguage: "mitsubishi-gx-st" });
}

describe("Semantic-loss records", () => {
  it("records a timer as a lossy loss with structured semantics and a required action", () => {
    const recs = losses("TON(RunTimer);");
    expect(recs).toHaveLength(1);
    const r = recs[0];
    expect(r.category).toBe("timers");
    expect(r.disposition).toBe("lossy");
    expect(r.sourceSemantics.length).toBeGreaterThan(0);
    expect(r.targetSemantics.length).toBeGreaterThan(0);
    expect(r.requiredAction).toMatch(/preset|wire|IN/i);
    expect(r.nodeId).toMatch(/^ir_/);
    expect(r.id).toBe(`loss_${r.nodeId}`);
  });

  it("records a PID as an unsupported/manual-port loss", () => {
    const recs = losses("PID(Loop1);");
    expect(recs).toHaveLength(1);
    expect(recs[0].category).toBe("process_control");
    expect(recs[0].disposition).toBe("manual_port");
  });

  it("does NOT record equivalent lowerings (COP/block_copy) as a loss", () => {
    const recs = losses("COP(src, dst, 10);");
    expect(recs).toHaveLength(0);
  });

  it("finds losses nested inside control flow", () => {
    const recs = losses("IF x THEN\n  TON(T1);\nEND_IF;");
    expect(recs).toHaveLength(1);
    expect(recs[0].category).toBe("timers");
  });

  it("is deterministic and stably ordered by node id", () => {
    const a = losses("TON(A);\nTON(B);\nCTU(C);");
    const b = losses("TON(A);\nTON(B);\nCTU(C);");
    expect(a.map((r) => r.nodeId)).toEqual(b.map((r) => r.nodeId));
    const sorted = [...a].sort((x, y) => (x.nodeId < y.nodeId ? -1 : 1));
    expect(a.map((r) => r.nodeId)).toEqual(sorted.map((r) => r.nodeId));
  });

  it("completeness is derived from losses (never silently complete when losses exist)", () => {
    expect(completenessFromLosses([], { hasError: false, outputEmpty: false, legacyNodeCount: 0 })).toBe("executable_complete");
    expect(completenessFromLosses([], { hasError: false, outputEmpty: false, legacyNodeCount: 2 })).toBe("generated");
    const recs = losses("TON(T);");
    expect(completenessFromLosses(recs, { hasError: false, outputEmpty: false, legacyNodeCount: 1 })).toBe("review_required");
  });

  it("surfaces through compile(): a mixed program carries the loss and review_required", () => {
    const res = compileLegacy("IF x > 0 THEN\n  y := 1;\nEND_IF;\nTON(RunTimer);", "ab2mel");
    expect(res.semanticLosses.length).toBeGreaterThan(0);
    expect(res.completeness).toBe("review_required");
    expect(res.stats.manualPortCount + res.stats.warningCount).toBe(res.semanticLosses.length);
  });

  it("a fully-canonical program has no losses and is executable_complete", () => {
    const res = compileLegacy("y := a + 1;\nz := b * 2;", "ab2mel");
    expect(res.semanticLosses).toEqual([]);
    expect(res.completeness).toBe("executable_complete");
  });
});
