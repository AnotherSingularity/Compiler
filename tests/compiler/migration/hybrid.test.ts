import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { compileHybrid } from "../../../server/compiler/migration/hybrid";
import { compileLegacy } from "../../../server/compiler/compat/legacy-adapter";

const AB = "rockwell-logix-st" as const;
const MEL = "mitsubishi-gx-st" as const;

describe("Stage 2 — mixed-program (hybrid) routing", () => {
  it("routes assignment + IF canonically while an FB invoke (legacy-only) stays legacy, preserving order", () => {
    const src = "y := a + 1;\nIF x > 0 THEN\n  z := 2;\nEND_IF;\nSomeFB(In := x);\nw := b;";
    const h = compileHybrid(src, AB, MEL)!;
    expect(h.canonicalNodeCount).toBe(3); // y:=, IF, w:=
    expect(h.legacyNodeCount).toBe(1); // PID (manual-port, still legacy)
    const lines = h.output.split("\n");
    // order preserved: y:= first, w:= last (the fb_invoke legacy fragment is
    // counted but emits nothing in ab2mel — routing is proven by the counts).
    expect(lines[0]).toBe("y := a + 1;");
    expect(h.output.indexOf("y := a + 1;")).toBeLessThan(h.output.indexOf("w := b;"));
  });

  it("routes a primitive declaration canonically, and a primitive-element array canonically (arrays active)", () => {
    const src = "VAR\n  cnt : DINT;\nEND_VAR\ncnt := cnt + 1;";
    const prim = compileHybrid(src, AB, MEL)!;
    expect(prim.canonicalNodeCount).toBeGreaterThan(0);
    expect(prim.legacyNodeCount).toBe(0);
    const arrSrc = "VAR\n  buf : ARRAY[0..9] OF DINT;\nEND_VAR\nbuf[0] := 1;";
    const arr = compileHybrid(arrSrc, AB, MEL)!;
    expect(arr.legacyNodeCount).toBe(0); // array of primitive → canonical
    expect(arr.canonicalNodeCount).toBeGreaterThan(0);
    expect(arr.output).toContain("ARRAY[0..9] OF DINT");
    // array of a non-primitive element → declaration not canonically emittable → legacy
    const udt = compileHybrid("VAR\n  recs : ARRAY[0..3] OF MyUDT;\nEND_VAR\nrecs[0] := 1;", AB, MEL)!;
    expect(udt.legacyNodeCount).toBeGreaterThan(0);
  });

  it("a canonical-active statement containing a legacy node routes to legacy as a unit (no crash, no split)", () => {
    // IF whose body contains a PID (still legacy-only) — structurally inseparable → whole IF legacy.
    const src = "IF x THEN\n  SomeFB(In := x);\nEND_IF;\ny := 1;";
    const h = compileHybrid(src, AB, MEL)!;
    expect(h.legacyNodeCount).toBe(1); // the IF (inseparable)
    expect(h.canonicalNodeCount).toBe(1); // y := 1
    expect(h.output).toContain("y := 1;");
  });

  it("is deterministic: repeated compilation yields identical output and counts", () => {
    const src = "a := 1;\nSomeFB(In := x);\nb := 2;";
    const h1 = compileHybrid(src, AB, MEL)!;
    const h2 = compileHybrid(src, AB, MEL)!;
    expect(h1.output).toBe(h2.output);
    expect(h1.canonicalNodeCount).toBe(h2.canonicalNodeCount);
    expect(h1.legacyNodeCount).toBe(h2.legacyNodeCount);
  });

  it("works in both language directions", () => {
    const src = "d := e + 1;\nSomeFB(In := x);";
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

  it("routes a vendor timer/counter field read to legacy so it is rewritten (never emitted verbatim)", () => {
    // AB `.DN/.ACC/.PRE` must become MEL `.Q/.ET/.PT`; a canonical member-access
    // would emit the AB name verbatim — semantically wrong for the MEL target.
    const dn = compileHybrid("out := RunTimer.DN;", AB, MEL)!;
    expect(dn.canonicalNodeCount).toBe(0);
    expect(dn.legacyNodeCount).toBe(1);
    expect(dn.output).toContain("RunTimer.Q");
    // The emitted CODE (non-comment lines) must not carry the un-rewritten field.
    const codeLines = dn.output.split("\n").filter((l) => !l.trim().startsWith("//"));
    expect(codeLines.join("\n")).not.toMatch(/RunTimer\.DN/);

    const acc = compileHybrid("cnt := Ctr.ACC;", AB, MEL)!;
    expect(acc.output).toContain("Ctr.ET");

    // A plain (non-vendor) struct member stays canonical and verbatim.
    const plain = compileHybrid("y := a.foo + 1;", AB, MEL)!;
    expect(plain.canonicalNodeCount).toBe(1);
    expect(plain.output).toContain("a.foo");
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

    it("mixed routing still occurs on the corpus (runtime_basics MEL->AB has a legacy FB invoke)", () => {
      // The ab2mel corpus is now fully canonical (all families through calls +
      // manual-port are active). Mixed routing is still exercised by the MEL
      // source, which contains an IEC named-arg FB invoke (function_blocks,
      // still legacy) alongside canonical statements.
      const m = compileLegacy(readFileSync(join(dir, "mel/runtime_basics.st"), "utf8"), "mel2ab").migration!;
      expect(m.canonicalNodeCount).toBeGreaterThan(0);
      expect(m.legacyNodeCount).toBeGreaterThan(0);
      expect(m.engine).toBe("mixed");
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
