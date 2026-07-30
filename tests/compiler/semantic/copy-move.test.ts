import { describe, it, expect } from "vitest";
import { compileHybrid } from "../../../server/compiler/migration/hybrid";

const AB = "rockwell-logix-st" as const;
const MEL = "mitsubishi-gx-st" as const;
const ab = (s: string) => compileHybrid(s, AB, MEL)!;
const mel = (s: string) => compileHybrid(s, MEL, AB)!;

describe("copy_move — canonical activation", () => {
  it("block copy: COP -> BMOV (ab2mel) and BMOV -> COP (mel2ab)", () => {
    const a = ab("COP(srcArr, dstArr, 10);");
    expect(a.canonicalNodeCount).toBe(1);
    expect(a.legacyNodeCount).toBe(0);
    expect(a.output).toBe("BMOV(srcArr, dstArr, 10);");
    expect(mel("BMOV(a, b, 4);").output).toBe("COP(a, b, 4);");
  });

  it("CPS lowers to a block move AND records an atomicity loss (never a silent equivalent)", () => {
    const h = ab("CPS(srcArr, dstArr, 10);");
    expect(h.output).toBe("BMOV(srcArr, dstArr, 10);");
    expect(h.canonicalNodeCount).toBe(1);
    expect(h.losses.some((l) => l.category === "copy_move_atomicity")).toBe(true);
    expect(h.losses.find((l) => l.category === "copy_move_atomicity")!.disposition).toBe("lossy");
  });

  it("masked move MVM passes through in both directions", () => {
    expect(ab("MVM(src, mask, dst);").output).toBe("MVM(src, mask, dst);");
    expect(mel("MVM(src, mask, dst);").output).toBe("MVM(src, mask, dst);");
  });

  it("limit test: LIM -> LIMIT (ab2mel), LIM stays LIM for the AB target (mel2ab)", () => {
    expect(ab("LIM(lo, val, hi);").output).toBe("LIMIT(lo, val, hi);");
    expect(mel("LIM(lo, val, hi);").output).toBe("LIM(lo, val, hi);");
  });

  it("a copy_move op stays canonical beside a legacy PID (mixed)", () => {
    const h = ab("COP(a, b, 3);\nPID(Loop1);");
    expect(h.canonicalNodeCount).toBe(1);
    expect(h.legacyNodeCount).toBe(1);
    expect(h.output).toContain("BMOV(a, b, 3);");
  });
});
