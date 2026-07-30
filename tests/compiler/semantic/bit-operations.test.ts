import { describe, it, expect } from "vitest";
import { compileHybrid } from "../../../server/compiler/migration/hybrid";

const AB = "rockwell-logix-st" as const;
const MEL = "mitsubishi-gx-st" as const;
const ab = (s: string) => compileHybrid(s, AB, MEL)!;

describe("bit_operations — canonical activation", () => {
  it("OTL (latch) -> portable `bit := TRUE;`", () => {
    const h = ab("OTL(MyBit);");
    expect(h.canonicalNodeCount).toBe(1);
    expect(h.legacyNodeCount).toBe(0);
    expect(h.output).toBe("MyBit := TRUE;");
  });

  it("OTU (unlatch) -> portable `bit := FALSE;`", () => {
    expect(ab("OTU(MyBit);").output).toBe("MyBit := FALSE;");
  });

  it("works on a bit-of-word reference", () => {
    expect(ab("OTL(Flags.3);").output).toBe("Flags.3 := TRUE;");
  });

  it("stays canonical beside a legacy PID (mixed)", () => {
    const h = ab("OTL(A);\nPID(Loop1);");
    expect(h.canonicalNodeCount).toBe(1);
    expect(h.legacyNodeCount).toBe(1);
    expect(h.output).toContain("A := TRUE;");
  });

  it("shift instructions are NOT guessed — they remain on the legacy engine", () => {
    // SHL/SHR are not mapped (target form is dialect-specific); routed legacy verbatim.
    const h = ab("SHL(word, 2, result);");
    expect(h.legacyNodeCount).toBeGreaterThan(0);
    expect(h.output).toContain("SHL");
  });
});
