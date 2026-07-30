import { describe, it, expect } from "vitest";
import { compileHybrid } from "../../../server/compiler/migration/hybrid";
import { parseDeclType, parseArrayType, emitDeclTypeSpelling } from "../../../server/compiler/ir/decl-types";
import type { ArrayType } from "../../../server/compiler/ir/types";

const AB = "rockwell-logix-st" as const;
const MEL = "mitsubishi-gx-st" as const;

describe("Array type parsing", () => {
  it("parses a 1-based array with preserved bounds", () => {
    const t = parseArrayType("ARRAY[1..100] OF DINT");
    expect(t).not.toBeNull();
    expect(t!.dimensions).toEqual([{ lower: 1, upper: 100, inferred: false }]);
    expect(t!.element.kind).toBe("integer");
  });

  it("parses a multidimensional array", () => {
    const t = parseArrayType("ARRAY[0..9, 0..3] OF INT");
    expect(t!.dimensions).toEqual([
      { lower: 0, upper: 9, inferred: false },
      { lower: 0, upper: 3, inferred: false },
    ]);
  });

  it("parses a negative lower bound", () => {
    const t = parseArrayType("ARRAY[-5..5] OF REAL");
    expect(t!.dimensions[0]).toEqual({ lower: -5, upper: 5, inferred: false });
  });

  it("rejects malformed bounds and non-primitive elements (→ not canonical)", () => {
    expect(parseArrayType("ARRAY[5..1] OF INT")).toBeNull(); // upper < lower
    expect(parseArrayType("ARRAY[1..10] OF SomeUDT")).toBeNull(); // non-primitive element
    expect(parseArrayType("DINT")).toBeNull();
    expect(parseDeclType("SomeUDT").kind).toBe("unresolved"); // never guessed
  });

  it("round-trips the type spelling (bounds preserved exactly)", () => {
    expect(emitDeclTypeSpelling(parseDeclType("ARRAY[1..100] OF DINT"))).toBe("ARRAY[1..100] OF DINT");
    expect(emitDeclTypeSpelling(parseDeclType("ARRAY[0..9, 0..3] OF INT"))).toBe("ARRAY[0..9, 0..3] OF INT");
  });
});

describe("Array declaration + access — canonical activation", () => {
  it("routes an array declaration + access canonically, preserving 1-based bounds", () => {
    const h = compileHybrid("VAR\n  buf : ARRAY[1..100] OF DINT;\nEND_VAR\nbuf[1] := 5;", AB, MEL)!;
    expect(h.legacyNodeCount).toBe(0);
    expect(h.canonicalNodeCount).toBeGreaterThan(0);
    expect(h.output).toContain("ARRAY[1..100] OF DINT");
    expect(h.output).not.toContain("ARRAY[0..99]"); // never silently rebased
    expect(h.output).toContain("buf[1] := 5;");
  });

  it("handles a multidimensional array end to end", () => {
    const h = compileHybrid("VAR\n  grid : ARRAY[0..9, 0..3] OF INT;\nEND_VAR\ngrid[2, 1] := 7;", AB, MEL)!;
    expect(h.output).toContain("ARRAY[0..9, 0..3] OF INT");
    expect(h.output).toContain("grid[2, 1] := 7;");
  });

  it("an array of a non-primitive element stays on the legacy engine", () => {
    const h = compileHybrid("VAR\n  recs : ARRAY[0..3] OF MyUDT;\nEND_VAR\nrecs[0].f := 1;", AB, MEL)!;
    // The declaration is not canonically emittable → whole decl block routes legacy.
    expect(h.legacyNodeCount).toBeGreaterThan(0);
  });

  it("primitive + array declarations coexist canonically (both families active)", () => {
    const h = compileHybrid("VAR\n  n : DINT;\n  buf : ARRAY[0..7] OF REAL;\nEND_VAR\nn := 1;\nbuf[0] := 1.0;", AB, MEL)!;
    expect(h.legacyNodeCount).toBe(0);
    expect(h.output).toContain("n : DINT;");
    expect(h.output).toContain("buf : ARRAY[0..7] OF REAL;");
  });
});
