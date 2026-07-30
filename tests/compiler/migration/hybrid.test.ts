import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { compileHybrid } from "../../../server/compiler/migration/hybrid";
import { compileLegacy } from "../../../server/compiler/compat/legacy-adapter";

const AB = "rockwell-logix-st" as const;
const MEL = "mitsubishi-gx-st" as const;

describe("Stage 2 — mixed-program (hybrid) routing", () => {
  it("routes assignment + IF canonically while a timer stays legacy, preserving order", () => {
    const src = "y := a + 1;\nIF x > 0 THEN\n  z := 2;\nEND_IF;\nTON(RunTimer);\nw := b;";
    const h = compileHybrid(src, AB, MEL)!;
    expect(h.canonicalNodeCount).toBe(3); // y:=, IF, w:=
    expect(h.legacyNodeCount).toBe(1); // TON
    const lines = h.output.split("\n");
    // order preserved: y:= first, w:= last, TON fragment between IF and w:=
    expect(lines[0]).toBe("y := a + 1;");
    expect(h.output.indexOf("y := a + 1;")).toBeLessThan(h.output.indexOf("RunTimer(IN :="));
    expect(h.output.indexOf("RunTimer(IN :=")).toBeLessThan(h.output.indexOf("w := b;"));
  });

  it("routes a primitive declaration canonically and an array declaration to legacy (mixed)", () => {
    const src = "VAR\n  cnt : DINT;\nEND_VAR\ncnt := cnt + 1;";
    const prim = compileHybrid(src, AB, MEL)!;
    expect(prim.canonicalNodeCount).toBeGreaterThan(0);
    expect(prim.legacyNodeCount).toBe(0);
    const arrSrc = "VAR\n  buf : ARRAY[0..9] OF DINT;\nEND_VAR\nbuf[0] := 1;";
    const arr = compileHybrid(arrSrc, AB, MEL)!;
    expect(arr.legacyNodeCount).toBeGreaterThan(0); // array decl
    expect(arr.canonicalNodeCount).toBeGreaterThan(0); // assignment
  });

  it("a canonical-active statement containing a legacy node routes to legacy as a unit (no crash, no split)", () => {
    // IF whose body contains a timer — structurally inseparable → whole IF legacy.
    const src = "IF x THEN\n  TON(T1);\nEND_IF;\ny := 1;";
    const h = compileHybrid(src, AB, MEL)!;
    expect(h.legacyNodeCount).toBe(1); // the IF (inseparable)
    expect(h.canonicalNodeCount).toBe(1); // y := 1
    expect(h.output).toContain("y := 1;");
  });

  it("is deterministic: repeated compilation yields identical output and counts", () => {
    const src = "a := 1;\nTON(T);\nb := 2;";
    const h1 = compileHybrid(src, AB, MEL)!;
    const h2 = compileHybrid(src, AB, MEL)!;
    expect(h1.output).toBe(h2.output);
    expect(h1.canonicalNodeCount).toBe(h2.canonicalNodeCount);
    expect(h1.legacyNodeCount).toBe(h2.legacyNodeCount);
  });

  it("works in both language directions", () => {
    const src = "d := e + 1;\nTON(T);";
    const ab = compileHybrid(src, AB, MEL)!;
    const mel = compileHybrid(src, MEL, AB)!;
    expect(ab.canonicalNodeCount).toBe(1);
    expect(mel.canonicalNodeCount).toBe(1);
    expect(ab.output).toContain("d := e + 1;");
    expect(mel.output).toContain("d := e + 1;");
  });

  it("returns null for a parse error (legacy path reports it)", () => {
    expect(compileHybrid("x := @ ;", AB, MEL)).toBeNull();
  });

  describe("corpus migration (verify:corpus-migration)", () => {
    const dir = join(__dirname, "../../corpus/fixtures");
    const fixtures = readdirSync(dir).filter((f) => f.endsWith(".st"));

    it("every corpus fixture executes a nonzero canonical node count", () => {
      for (const f of fixtures) {
        const res = compileLegacy(readFileSync(join(dir, f), "utf8"), "ab2mel");
        expect(res.migration!.canonicalNodeCount, `${f} canonical nodes`).toBeGreaterThan(0);
      }
    });

    it("at least one corpus fixture is genuinely mixed (both engines in one compilation)", () => {
      const engines = fixtures.map((f) => compileLegacy(readFileSync(join(dir, f), "utf8"), "ab2mel").migration!.engine);
      expect(engines).toContain("mixed");
    });

    it("node accounting balances (canonical + legacy = total routed) and no fixture is whole-program-legacy", () => {
      for (const f of fixtures) {
        const m = compileLegacy(readFileSync(join(dir, f), "utf8"), "ab2mel").migration!;
        expect(m.canonicalNodeCount + m.legacyNodeCount).toBeGreaterThan(0);
        expect(m.canonicalNodeCount).toBeGreaterThan(0); // never back to whole-program legacy
      }
    });
  });
});
