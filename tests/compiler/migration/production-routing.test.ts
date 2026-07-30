import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { compileLegacy } from "../../../server/compiler/compat/legacy-adapter";
import { defaultRegistry } from "../../../server/compiler/migration/families";

describe("Stage 3 — production routing (expressions/assignments/control_flow are canonical-active)", () => {
  it("registry marks expressions/assignments/control_flow/declarations/conversions/arrays_structures canonical_active, timers/counters/calls legacy", () => {
    const reg = defaultRegistry();
    expect(reg.isActive("expressions")).toBe(true);
    expect(reg.isActive("assignments")).toBe(true);
    expect(reg.isActive("control_flow")).toBe(true);
    expect(reg.isActive("declarations")).toBe(true);
    expect(reg.isActive("conversions")).toBe(true);
    expect(reg.isActive("arrays_structures")).toBe(true);
    expect(reg.isActive("timers")).toBe(false);
    expect(reg.isActive("counters")).toBe(false);
    expect(reg.isActive("calls")).toBe(false);
  });

  it("primitive AND array VAR declarations compile via the CANONICAL engine; a non-primitive-element array stays legacy", () => {
    const prim = compileLegacy("VAR\n  cnt : DINT;\n  ok : BOOL := 1;\nEND_VAR\ncnt := cnt + 1;", "ab2mel");
    expect(prim.migration?.engine).toBe("canonical");
    expect(prim.artifacts.find((a) => a.name === "output.st")?.content).toContain("cnt : DINT;");
    // array of a primitive → canonical now (arrays_structures active), bounds preserved
    const arr = compileLegacy("VAR\n  buf : ARRAY[0..9] OF DINT;\nEND_VAR\nbuf[0] := 1;", "ab2mel");
    expect(arr.migration?.engine).toBe("canonical");
    expect(arr.artifacts.find((a) => a.name === "output.st")?.content).toContain("ARRAY[0..9] OF DINT");
    // array of a UDT (non-primitive element) is not canonically emittable → mixed
    const udt = compileLegacy("VAR\n  recs : ARRAY[0..3] OF MyUDT;\nEND_VAR\nrecs[0] := 1;", "ab2mel");
    expect(udt.migration?.engine).toBe("mixed");
  });

  it("a pure expression/assignment program compiles via the CANONICAL engine", () => {
    const res = compileLegacy("y := a + b * 2 - 1;", "ab2mel");
    expect(res.migration?.engine).toBe("canonical");
    expect(res.artifacts.find((a) => a.name === "output.st")?.content).toBe("y := a + b * 2 - 1;");
    expect(res.diagnostics.some((d) => d.code === "MIGRATION_HYBRID_ROUTING")).toBe(true);
  });

  it("a pure control-flow program compiles via the CANONICAL engine, both directions", () => {
    const src = "IF x > 0 THEN\n  y := 1;\nELSE\n  y := 0;\nEND_IF;";
    for (const dir of ["ab2mel", "mel2ab"] as const) {
      const res = compileLegacy(src, dir);
      expect(res.migration?.engine).toBe("canonical");
      const out = res.artifacts.find((a) => a.name === "output.st")?.content ?? "";
      expect(out).toContain("IF x > 0 THEN");
      expect(out).toContain("END_IF;");
    }
  });

  it("a mixed program (IF canonical + timer legacy) routes hybrid, not whole-program legacy; IF stays canonical", () => {
    const src = "IF x > 0 THEN\n  y := 1;\nEND_IF;\nTON(RunTimer);";
    const res = compileLegacy(src, "ab2mel");
    expect(res.migration?.engine).toBe("mixed");
    expect((res.migration?.canonicalNodeCount ?? 0)).toBeGreaterThan(0);
    expect((res.migration?.legacyNodeCount ?? 0)).toBeGreaterThan(0);
    const out = res.artifacts.find((a) => a.name === "output.st")?.content ?? "";
    expect(out).toContain("IF x > 0 THEN"); // canonical
    expect(out).toContain("RunTimer(IN :="); // legacy fragment
  });

  it("a mixed program with a function call keeps the assignment canonical and the call legacy", () => {
    const res = compileLegacy("z := 1;\nMyFunc(a, b);", "ab2mel");
    expect(res.migration?.engine).toBe("mixed");
    expect((res.migration?.canonicalNodeCount ?? 0)).toBeGreaterThan(0);
  });

  it("every corpus fixture executes a NONZERO canonical node count via hybrid routing", () => {
    // Corpus fixtures mix canonical (assignments/IF) with legacy families →
    // hybrid must produce canonical nodes, not whole-program legacy.
    const dir = join(__dirname, "../../corpus/fixtures");
    for (const f of ["01_ARRAY100_AVERAGE.st", "05_HMI_ALARM_MESSAGE.st"]) {
      const src = readFileSync(join(dir, f), "utf8");
      const res = compileLegacy(src, "ab2mel");
      expect(res.artifacts.find((a) => a.name === "output.st")?.content?.length).toBeGreaterThan(0);
      expect((res.migration?.canonicalNodeCount ?? 0)).toBeGreaterThan(0);
    }
  });
});
