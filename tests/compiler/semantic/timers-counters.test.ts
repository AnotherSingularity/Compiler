import { describe, it, expect } from "vitest";
import { compileHybrid } from "../../../server/compiler/migration/hybrid";
import { collectInstances, canonicalFieldOf, targetFieldSpelling } from "../../../server/compiler/semantic/instance-members";
import { buildSemanticProgram } from "../../../server/compiler/semantic/pipeline";
import { parseSTSourceWithDiagnostics } from "../../../server/compiler/parser";
import type { LanguageId } from "../../../server/compiler/contracts/ids";

const AB = "rockwell-logix-st" as const;
const MEL = "mitsubishi-gx-st" as const;

function out(src: string, s: LanguageId = AB, t: LanguageId = MEL) {
  return compileHybrid(src, s, t)!;
}

describe("Timer/counter instance + field model", () => {
  it("detects timer/counter instances from operation usage (not from names)", () => {
    const p = buildSemanticProgram(parseSTSourceWithDiagnostics("TON(A);\nCTU(B);\nx := C.DN;").ast, AB, MEL);
    const inst = collectInstances(p.routines[0].body);
    expect(inst.get("A")).toBe("timer");
    expect(inst.get("B")).toBe("counter");
    expect(inst.get("C")).toBeUndefined(); // never used as an operation instance → not classified
  });

  it("maps vendor field spellings to canonical fields and re-spells per target", () => {
    expect(canonicalFieldOf("DN", "timer")).toBe("done");
    expect(canonicalFieldOf("ACC", "timer")).toBe("accumulator");
    expect(canonicalFieldOf("Q", "timer")).toBe("done");
    expect(targetFieldSpelling("done", "timer", MEL)).toBe("Q");
    expect(targetFieldSpelling("done", "timer", AB)).toBe("DN");
    expect(targetFieldSpelling("accumulator", "counter", MEL)).toBe("CV");
  });
});

describe("Timers — canonical activation", () => {
  it("emits an FB invoke with explicit TODO placeholders and NEVER a fake zero preset", () => {
    const h = out("TON(RunTimer);");
    expect(h.canonicalNodeCount).toBe(1);
    expect(h.legacyNodeCount).toBe(0);
    expect(h.output).toBe("RunTimer(IN := TODO_RunTimer_enable, PT := TODO_RunTimer_preset);");
    expect(h.output).not.toContain("T#0ms");
    expect(h.losses.some((l) => l.category === "timers")).toBe(true);
  });

  it("re-spells timer status fields for the target (.DN -> .Q ab2mel, .Q -> .DN mel2ab)", () => {
    expect(out("TON(T);\nx := T.DN;").output).toContain("x := T.Q;");
    expect(out("TON(T);\nx := T.Q;", MEL, AB).output).toContain("x := T.DN;");
  });
});

describe("Counters — canonical activation + typed RES", () => {
  it("emits a counter FB invoke and re-spells fields (.DN -> .Q, .ACC -> .CV)", () => {
    const h = out("CTU(MyCtr);\ndone := MyCtr.DN;\ncur := MyCtr.ACC;");
    expect(h.legacyNodeCount).toBe(0);
    expect(h.output).toContain("MyCtr(CU := TODO_MyCtr_count_up, R := TODO_MyCtr_reset, PV := TODO_MyCtr_preset);");
    expect(h.output).toContain("done := MyCtr.Q;");
    expect(h.output).toContain("cur := MyCtr.CV;");
  });

  it("resolves RES by the operand's actual kind — counter reset for a counter", () => {
    const h = out("CTU(C);\nRES(C);");
    expect(h.output).toContain("C(R := TRUE); (* counter reset *)");
  });

  it("resolves RES to a timer reset for a timer instance", () => {
    const h = out("TON(T);\nRES(T);");
    expect(h.output).toContain("T(IN := FALSE); (* timer reset *)");
  });

  it("an unresolved RES operand is an explicit unsupported/manual-port node (never name-guessed)", () => {
    const h = out("RES(Mystery);");
    // Not resolvable to a timer/counter → routes legacy as an unsupported node with a loss.
    expect(h.losses.some((l) => l.category === "unsupported")).toBe(true);
  });
});
