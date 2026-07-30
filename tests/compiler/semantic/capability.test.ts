import { describe, it, expect } from "vitest";
import { evaluateOperation, applyCapabilityDispositions, IR_TO_CAPABILITY_KEY } from "../../../server/compiler/capability/evaluator";
import { manifestForTarget } from "../../../server/compiler/capability/manifests";
import { normalizeStProgram } from "../../../server/compiler/ir/normalize";
import { normalizeProgramOperations, mnemonicRule } from "../../../server/compiler/semantic/operation-normalization";
import { parseSTSourceWithDiagnostics } from "../../../server/compiler/parser";
import type { CapabilityManifest } from "../../../server/compiler/contracts/capability";

const MEL = manifestForTarget("mitsubishi-gx-st")!;

function opProgram(src: string) {
  return normalizeProgramOperations(
    normalizeStProgram("MAIN", parseSTSourceWithDiagnostics(src).ast, { sourceId: "<t>", language: "rockwell-logix-st" }),
  );
}

describe("Authoritative capability evaluation", () => {
  it("resolves a manifest for both production targets, null for others", () => {
    expect(manifestForTarget("mitsubishi-gx-st")).not.toBeNull();
    expect(manifestForTarget("rockwell-logix-st")).not.toBeNull();
    expect(manifestForTarget("iec-61131-3-st")).toBeNull();
  });

  it("evaluates a declared operation to the manifest disposition", () => {
    const e = evaluateOperation("timer_on_delay", MEL, "exact");
    expect(e.capabilityKey).toBe("TimerOnDelay");
    expect(e.disposition).toBe("lossy");
    expect(e.undeclared).toBe(false);
  });

  it("falls back to the provided disposition when the manifest does not declare the op", () => {
    const bare: CapabilityManifest = { language: "mitsubishi-gx-st", version: "t", operations: {}, types: {}, projectFeatures: {} };
    const e = evaluateOperation("timer_on_delay", bare, "lossy");
    expect(e.undeclared).toBe(true);
    expect(e.disposition).toBe("lossy"); // never silently upgraded to supported
  });

  it("re-stamps a program's operation dispositions from the manifest (authoritative)", () => {
    const prog = opProgram("PID(Loop1);");
    const stamped = applyCapabilityDispositions(prog, MEL);
    const op = stamped.routines[0].body.find((s) => s.node === "semantic_operation");
    expect(op).toBeTruthy();
    if (op && op.node === "semantic_operation") {
      expect(op.operation).toBe("pid_control");
      expect(op.disposition).toBe("manual_port"); // from the manifest
    }
  });

  it("is pure and deterministic (ids/order preserved, input untouched)", () => {
    const prog = opProgram("TON(T1);\nCOP(a, b, 3);");
    const snap = JSON.stringify(prog);
    const a = JSON.stringify(applyCapabilityDispositions(prog, MEL));
    const b = JSON.stringify(applyCapabilityDispositions(prog, MEL));
    expect(a).toBe(b);
    expect(JSON.stringify(prog)).toBe(snap);
  });

  it("every mnemonic the normalizer emits maps to a capability key or is intentionally unmapped", () => {
    for (const m of ["TON", "TOF", "RTO", "CTU", "CTD", "COP", "CPS", "MVM", "MSG", "PID", "JSR"]) {
      const rule = mnemonicRule(m);
      expect(rule, m).toBeTruthy();
      const irKind = rule!.operation;
      const mapped = irKind in IR_TO_CAPABILITY_KEY;
      const unmapped = irKind === "limit_test"; // LIM lowers to an inline expression
      expect(mapped || unmapped, `${m} → ${irKind}`).toBe(true);
    }
  });
});
