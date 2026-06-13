import { describe, it, expect } from "vitest";
import { translate } from "../server/translate";

describe("Translation Engine", () => {
  describe("AB to MEL direction", () => {
    it("translates simple assignment unchanged", () => {
      const result = translate("x := 1;", "ab2mel");
      expect(result.ok).toBe(true);
      expect(result.output).toContain("x := 1;");
    });

    it("preserves IF/THEN/END_IF structure", () => {
      const source = "IF x > 0 THEN\n  y := 1;\nEND_IF;";
      const result = translate(source, "ab2mel");
      expect(result.ok).toBe(true);
      expect(result.output).toContain("IF");
      expect(result.output).toContain("END_IF");
    });

    it("rewrites TON(instance) to MEL FB invocation", () => {
      const source = "TON(RunTimer);";
      const result = translate(source, "ab2mel");
      expect(result.ok).toBe(true);
      expect(result.output).toContain("RunTimer(IN :=");
      expect(result.output).toContain("PT :=");
    });

    it("rewrites CTU(instance) to MEL FB invocation", () => {
      const source = "CTU(MyCounter);";
      const result = translate(source, "ab2mel");
      expect(result.ok).toBe(true);
      expect(result.output).toContain("MyCounter(CU :=");
      expect(result.output).toContain("PV :=");
    });

    it("rewrites timer member .DN to .Q", () => {
      const source = "IF RunTimer.DN THEN\n  Output := TRUE;\nEND_IF;";
      const result = translate(source, "ab2mel");
      expect(result.ok).toBe(true);
      expect(result.output).toContain(".Q");
      // The provenance comment preserves original text with .DN, but the translated line has .Q
      const translatedLines = result.output.split("\n").filter(l => !l.includes("// [AB"));
      const hasQ = translatedLines.some(l => l.includes(".Q"));
      const hasDN = translatedLines.some(l => l.includes(".DN"));
      expect(hasQ).toBe(true);
      expect(hasDN).toBe(false);
    });

    it("rewrites timer member .PRE to .PT", () => {
      const source = "RunTimer.PRE := 5000;";
      const result = translate(source, "ab2mel");
      expect(result.ok).toBe(true);
      expect(result.output).toContain(".PT");
    });

    it("rewrites timer member .ACC to .ET", () => {
      const source = "elapsed := RunTimer.ACC;";
      const result = translate(source, "ab2mel");
      expect(result.ok).toBe(true);
      expect(result.output).toContain(".ET");
    });

    it("allocates device addresses for VAR declarations", () => {
      const source = "VAR\n  MyBool : BOOL;\n  MyInt : DINT;\nEND_VAR";
      const result = translate(source, "ab2mel");
      expect(result.ok).toBe(true);
      expect(result.output).toContain("AT M");
      expect(result.output).toContain("AT D");
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

    it("warns on retentive timer RTO", () => {
      const source = "RTO(RetTimer);";
      const result = translate(source, "ab2mel");
      expect(result.diagnostics.some(d => d.severity === "WARN")).toBe(true);
    });

    it("reports correct line counts", () => {
      const source = "x := 1;\ny := 2;\nz := 3;";
      const result = translate(source, "ab2mel");
      expect(result.stats.inputLines).toBe(3);
      expect(result.stats.outputLines).toBe(3);
    });

    it("generates mapping YAML for allocated vars", () => {
      const source = "VAR\n  Speed : REAL;\nEND_VAR";
      const result = translate(source, "ab2mel");
      expect(result.mappingYaml).toContain("Speed");
      expect(result.mappingYaml).toContain("device:");
    });

    it("generates labels CSV", () => {
      const source = "VAR\n  Flag : BOOL;\nEND_VAR";
      const result = translate(source, "ab2mel");
      expect(result.labelsCsv).toContain("Flag");
      expect(result.labelsCsv).toContain("BOOL");
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
      expect(result.diagnostics.some(d => d.severity === "WARN")).toBe(true);
    });

    it("converts MEL FB invocation to AB style", () => {
      const source = "MyTimer(IN := Enable, PT := T#5000);";
      const result = translate(source, "mel2ab");
      expect(result.ok).toBe(true);
      expect(result.output).toContain("TON(MyTimer)");
    });
  });
});
