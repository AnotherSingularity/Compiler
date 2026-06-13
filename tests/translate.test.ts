import { describe, it, expect } from "vitest";
import { translate } from "../server/translate";

describe("Translation Engine", () => {
  describe("AB to MEL direction", () => {
    it("translates simple assignment", () => {
      const result = translate("x := 1;", "ab2mel");
      expect(result.ok).toBe(true);
      expect(result.output).toContain("x := 1;");
    });

    it("translates IF/THEN/END_IF", () => {
      const source = "IF x > 0 THEN\n  y := 1;\nEND_IF;";
      const result = translate(source, "ab2mel");
      expect(result.ok).toBe(true);
      expect(result.output).toContain("IF");
      expect(result.output).toContain("END_IF");
    });

    it("rewrites timer member .DN to .Q", () => {
      const source = "IF RunTimer.DN THEN\n  Output := TRUE;\nEND_IF;";
      const result = translate(source, "ab2mel");
      expect(result.ok).toBe(true);
      expect(result.output).toContain(".Q");
      expect(result.output).not.toContain(".DN");
    });

    it("rewrites timer member .PRE to .PT", () => {
      const source = "RunTimer.PRE := 5000;";
      const result = translate(source, "ab2mel");
      expect(result.ok).toBe(true);
      expect(result.output).toContain(".PT");
    });

    it("rewrites counter member .ACC (shared with timer)", () => {
      const source = "count := MyCounter.ACC;";
      const result = translate(source, "ab2mel");
      expect(result.ok).toBe(true);
      // .ACC is a shared member between timer and counter
      // Without full type resolution, it maps to .ET (timer convention)
      expect(result.output).toContain(".ET");
    });

    it("emits MANUAL_PORT for PIDE", () => {
      const source = "PIDE(Loop1);";
      const result = translate(source, "ab2mel");
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.diagnostics[0].severity).toBe("MANUAL_PORT");
      expect(result.output).toContain("MANUAL PORT");
    });

    it("emits MANUAL_PORT for MSG", () => {
      const source = "MSG(CommMsg);";
      const result = translate(source, "ab2mel");
      expect(result.diagnostics[0].severity).toBe("MANUAL_PORT");
    });

    it("emits MANUAL_PORT for motion instructions", () => {
      const source = "MAM(Axis1);";
      const result = translate(source, "ab2mel");
      expect(result.diagnostics[0].severity).toBe("MANUAL_PORT");
    });

    it("reports correct stats", () => {
      const source = "x := 1;\ny := 2;\nz := 3;";
      const result = translate(source, "ab2mel");
      expect(result.stats.inputLines).toBe(3);
      expect(result.stats.outputLines).toBe(3);
    });
  });

  describe("MEL to AB direction", () => {
    it("translates simple assignment", () => {
      const result = translate("x := 1;", "mel2ab");
      expect(result.ok).toBe(true);
      expect(result.output).toContain("x := 1;");
    });

    it("rewrites timer member .Q to .DN", () => {
      const source = "IF RunTimer.Q THEN\n  Output := TRUE;\nEND_IF;";
      const result = translate(source, "mel2ab");
      expect(result.ok).toBe(true);
      expect(result.output).toContain(".DN");
    });

    it("rewrites timer member .ET to .ACC", () => {
      const source = "elapsed := RunTimer.ET;";
      const result = translate(source, "mel2ab");
      expect(result.ok).toBe(true);
      expect(result.output).toContain(".ACC");
    });

    it("warns on RETURN statement", () => {
      const source = "IF error THEN\n  RETURN;\nEND_IF;";
      const result = translate(source, "mel2ab");
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.diagnostics[0].severity).toBe("WARN");
      expect(result.diagnostics[0].code).toBe("AB_MEL_EMIT_001");
    });

    it("flags device references", () => {
      const source = "x := D100;";
      const result = translate(source, "mel2ab");
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });
  });
});
