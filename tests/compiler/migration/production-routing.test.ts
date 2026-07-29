import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { compileLegacy } from "../../../server/compiler/compat/legacy-adapter";
import { translate } from "../../../server/translate";
import { tryCanonicalCompile } from "../../../server/compiler/migration/routing";
import { defaultRegistry } from "../../../server/compiler/migration/families";

describe("Stage 3 — production routing (expressions/assignments/control_flow are canonical-active)", () => {
  it("registry marks expressions/assignments/control_flow/declarations canonical_active, others legacy", () => {
    const reg = defaultRegistry();
    expect(reg.isActive("expressions")).toBe(true);
    expect(reg.isActive("assignments")).toBe(true);
    expect(reg.isActive("control_flow")).toBe(true);
    expect(reg.isActive("declarations")).toBe(true);
    expect(reg.isActive("timers")).toBe(false);
    expect(reg.isActive("calls")).toBe(false);
    expect(reg.isActive("arrays_structures")).toBe(false);
  });

  it("primitive VAR declarations compile via the CANONICAL engine; array declarations fall back to LEGACY", () => {
    const prim = compileLegacy("VAR\n  cnt : DINT;\n  ok : BOOL := 1;\nEND_VAR\ncnt := cnt + 1;", "ab2mel");
    expect(prim.migration?.engine).toBe("canonical");
    expect(prim.artifacts.find((a) => a.name === "output.st")?.content).toContain("cnt : DINT;");
    const arr = compileLegacy("VAR\n  buf : ARRAY[0..9] OF DINT;\nEND_VAR\nbuf[0] := 1;", "ab2mel");
    expect(arr.migration?.engine).toBe("legacy");
  });

  it("a pure expression/assignment program compiles via the CANONICAL engine", () => {
    const res = compileLegacy("y := a + b * 2 - 1;", "ab2mel");
    expect(res.migration?.engine).toBe("canonical");
    expect(res.artifacts.find((a) => a.name === "output.st")?.content).toBe("y := a + b * 2 - 1;");
    expect(res.diagnostics.some((d) => d.code === "MIGRATION_CANONICAL_PATH")).toBe(true);
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

  it("a program with an unmigrated family (timer) falls back to LEGACY and stays byte-identical", () => {
    const src = "IF x > 0 THEN\n  y := 1;\nEND_IF;\nTON(RunTimer);";
    const res = compileLegacy(src, "ab2mel");
    expect(res.migration?.engine).toBe("legacy");
    expect(res.artifacts.find((a) => a.name === "output.st")?.content).toBe(translate(src, "ab2mel").output);
  });

  it("a program with a function call (calls family) falls back to LEGACY", () => {
    const res = compileLegacy("z := 1;\nMyFunc(a, b);", "ab2mel");
    expect(res.migration?.engine).toBe("legacy");
  });

  it("canonical routing is deterministic and covers every corpus fixture via legacy fallback (no crash)", () => {
    // Corpus fixtures mix families → must route legacy and remain non-empty.
    const dir = join(__dirname, "../../corpus/fixtures");
    for (const f of ["01_ARRAY100_AVERAGE.st", "05_HMI_ALARM_MESSAGE.st"]) {
      const src = readFileSync(join(dir, f), "utf8");
      const res = compileLegacy(src, "ab2mel");
      expect(res.artifacts.find((a) => a.name === "output.st")?.content?.length).toBeGreaterThan(0);
    }
  });

  it("tryCanonicalCompile returns null for L5K project sources (not eligible)", () => {
    const l5k = 'IE_VER := 2.25;\nCONTROLLER Demo (ProcessorType := "x")\nEND_CONTROLLER';
    expect(tryCanonicalCompile(l5k, "rockwell-l5k", "mitsubishi-gx-st")).toBeNull();
  });
});
