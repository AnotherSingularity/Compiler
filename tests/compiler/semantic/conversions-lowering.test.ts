import { describe, it, expect } from "vitest";
import { compileHybrid } from "../../../server/compiler/migration/hybrid";
import { lowerConversions, isConversionFunction } from "../../../server/compiler/semantic/conversion-lowering";
import { buildSemanticProgram } from "../../../server/compiler/semantic/pipeline";
import { parseSTSourceWithDiagnostics } from "../../../server/compiler/parser";
import type { AssignmentStmt } from "../../../server/compiler/ir/statements";

const AB = "rockwell-logix-st" as const;
const MEL = "mitsubishi-gx-st" as const;

function convNode(src: string) {
  const p = buildSemanticProgram(parseSTSourceWithDiagnostics(src).ast, AB, MEL);
  const a = p.routines[0].body.find((s) => s.node === "assignment") as AssignmentStmt;
  return a.value;
}

describe("Conversion recognition + lowering", () => {
  it("recognizes IEC TYPE_TO_TYPE names", () => {
    expect(isConversionFunction("DINT_TO_REAL")).toBe(true);
    expect(isConversionFunction("BYTE_TO_INT")).toBe(true);
    expect(isConversionFunction("MY_FUNC")).toBe(false);
    expect(isConversionFunction("FOO_TO_BAR")).toBe(false); // unknown types
  });

  it("lowers DINT_TO_REAL to a conversion node with from/to and widening/precision safety", () => {
    const v = convNode("r := DINT_TO_REAL(n);");
    expect(v.node).toBe("conversion");
    if (v.node === "conversion") {
      expect(v.from.sourceSpelling).toBe("DINT");
      expect(v.to.sourceSpelling).toBe("REAL");
      expect(v.to.kind).toBe("real");
      expect(v.safety).toBe("precision_loss"); // DINT(32) > 24-bit significand
    }
  });

  it("classifies REAL_TO_INT as narrowing and INT_TO_UINT as signedness_change", () => {
    const narrow = convNode("n := REAL_TO_INT(r);");
    const sign = convNode("u := INT_TO_UINT(i);");
    if (narrow.node === "conversion") expect(narrow.safety).toBe("narrowing");
    if (sign.node === "conversion") expect(sign.safety).toBe("signedness_change");
  });

  it("leaves an unknown-type conversion-shaped name as an ordinary function call", () => {
    const v = convNode("x := FOO_TO_BAR(y);");
    expect(v.node).toBe("function_call");
  });

  it("emits the exact <FROM>_TO_<TO> form (round-trip-exact, incl. BYTE/WORD)", () => {
    for (const [src, expected] of [
      ["r := DINT_TO_REAL(n);", "r := DINT_TO_REAL(n);"],
      ["n := REAL_TO_INT(r);", "n := REAL_TO_INT(r);"],
      ["b := BYTE_TO_INT(c);", "b := BYTE_TO_INT(c);"],
      ["w := WORD_TO_DINT(v);", "w := WORD_TO_DINT(v);"],
    ] as const) {
      const h = compileHybrid(src, AB, MEL)!;
      expect(h.canonicalNodeCount).toBe(1);
      expect(h.output).toBe(expected);
    }
  });

  it("stays canonical beside a legacy timer (mixed) and records a conversion loss", () => {
    const h = compileHybrid("r := DINT_TO_REAL(n) + 1.0;\nTON(T1);", AB, MEL)!;
    expect(h.canonicalNodeCount).toBe(1); // the conversion assignment
    expect(h.legacyNodeCount).toBe(1); // the timer
    const cats = h.losses.map((l) => l.category);
    expect(cats).toContain("conversion_precision"); // DINT→REAL
    expect(cats).toContain("timers");
  });

  it("is pure (input program not mutated by lowerConversions)", () => {
    const base = buildSemanticProgram(parseSTSourceWithDiagnostics("r := DINT_TO_REAL(n);").ast, AB, MEL);
    const snap = JSON.stringify(base);
    lowerConversions(base);
    expect(JSON.stringify(base)).toBe(snap);
  });
});
