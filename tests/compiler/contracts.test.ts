import { describe, it, expect } from "vitest";
import { translate } from "../../server/translate";
import {
  compile,
  compileLegacy,
  legacyRequest,
  directionToLanguages,
  CompileRequestError,
} from "../../server/compiler/compat/legacy-adapter";
import {
  ALL_LANGUAGE_IDS,
  ALL_ARTIFACT_KINDS,
  ALL_DISPOSITIONS,
  isLanguageId,
  compareDiagnostics,
  sortDiagnostics,
  canonicalJson,
  hashValue,
  type CompilerDiagnostic,
  type CompileResult,
} from "../../server/compiler/contracts";

const AB_SRC = "IF x > 0 THEN\n  y := 1;\nEND_IF;\nTON(RunTimer);\nSomeFB(In := x);"; // mixed: IF+TON canonical (timer loss), FB invoke legacy
const MEL_SRC = "RunTimer(IN := start, PT := T#5s);";
// A pure-legacy program (only unmigrated families) — compile() still equals
// translate() here because a program with zero canonical nodes routes to the
// whole-program legacy bridge.
const LEGACY_SRC = "SomeFB(In := x);"; // still legacy-only (function_blocks) — routes whole-program legacy

describe("Phase 1 — compiler contracts", () => {
  describe("legacy direction adapter equivalence", () => {
    it("ab2mel pure-legacy program: compile output matches legacy translate output", () => {
      const legacy = translate(LEGACY_SRC, "ab2mel");
      const res = compileLegacy(LEGACY_SRC, "ab2mel");
      const outputArtifact = res.artifacts.find((a) => a.name === "output.st");
      expect(outputArtifact?.content).toBe(legacy.output);
      expect(res.ok).toBe(legacy.ok);
      expect(res.migration?.engine).toBe("legacy");
    });

    it("ab2mel mixed program: IF+TON canonical while an FB invoke stays legacy (mixed routing)", () => {
      const res = compileLegacy(AB_SRC, "ab2mel");
      expect(res.migration?.engine).toBe("mixed");
      expect((res.migration?.canonicalNodeCount ?? 0)).toBeGreaterThan(0);
      expect((res.migration?.legacyNodeCount ?? 0)).toBeGreaterThan(0);
      const out = res.artifacts.find((a) => a.name === "output.st")?.content ?? "";
      expect(out).toContain("IF x > 0 THEN"); // canonical control-flow emission
      expect(out).toContain("RunTimer(IN :="); // canonical timer emission
    });

    it("mel2ab: compile output matches legacy translate output", () => {
      const legacy = translate(MEL_SRC, "mel2ab");
      const res = compileLegacy(MEL_SRC, "mel2ab");
      const outputArtifact = res.artifacts.find((a) => a.name === "output.st");
      expect(outputArtifact?.content).toBe(legacy.output);
      expect(res.ok).toBe(legacy.ok);
      expect(res.sourceLanguage).toBe("mitsubishi-gx-st");
      expect(res.targetLanguage).toBe("rockwell-logix-st");
    });

    it("the adapter carries every compile diagnostic through and enriches with loss records", () => {
      const legacy = translate(LEGACY_SRC, "ab2mel");
      const res = compileLegacy(LEGACY_SRC, "ab2mel");
      // translate() reshapes the CompileResult and additionally surfaces the
      // authoritative loss records as diagnostics — so it never has FEWER
      // diagnostics than compile(), and the manual-port signal survives.
      expect(legacy.diagnostics.length).toBeGreaterThanOrEqual(res.diagnostics.length);
    });

    it("directionToLanguages maps both legacy directions", () => {
      expect(directionToLanguages("ab2mel")).toEqual({ sourceLanguage: "auto", targetLanguage: "mitsubishi-gx-st" });
      expect(directionToLanguages("mel2ab")).toEqual({ sourceLanguage: "mitsubishi-gx-st", targetLanguage: "rockwell-logix-st" });
    });

    it("resolves auto source to rockwell-l5k when the input looks like L5K", () => {
      const l5k = 'IE_VER := 2.25;\nCONTROLLER Demo (ProcessorType := "x")\n  PROGRAM Main\n    ROUTINE R\n      N: XIC(a)OTE(b) ;\n    END_ROUTINE\n  END_PROGRAM\nEND_CONTROLLER';
      const res = compileLegacy(l5k, "ab2mel");
      expect(res.sourceLanguage).toBe("rockwell-l5k");
    });
  });

  describe("request validation", () => {
    it("rejects empty source artifact list", () => {
      expect(() => compile({ sourceLanguage: "auto", targetLanguage: "mitsubishi-gx-st", sourceArtifacts: [] })).toThrow(CompileRequestError);
    });

    it("rejects all-empty source content", () => {
      expect(() =>
        compile({ sourceLanguage: "auto", targetLanguage: "mitsubishi-gx-st", sourceArtifacts: [{ id: "a", content: "   " }] }),
      ).toThrow(CompileRequestError);
    });

    it("rejects an unknown target language", () => {
      expect(() =>
        compile({ sourceLanguage: "auto", targetLanguage: "klingon-st" as never, sourceArtifacts: [{ id: "a", content: "x := 1;" }] }),
      ).toThrow(CompileRequestError);
    });

    it("rejects an unknown explicit source language", () => {
      expect(() =>
        compile({ sourceLanguage: "klingon-st" as never, targetLanguage: "mitsubishi-gx-st", sourceArtifacts: [{ id: "a", content: "x := 1;" }] }),
      ).toThrow(CompileRequestError);
    });

    it("legacyRequest builds a well-formed request", () => {
      const req = legacyRequest(AB_SRC, "ab2mel", { memoryMap: "m" });
      expect(req.sourceArtifacts).toHaveLength(1);
      expect(req.targetLanguage).toBe("mitsubishi-gx-st");
      expect(req.options?.memoryMap).toBe("m");
    });
  });

  describe("illegal combination rejection (fail closed)", () => {
    it("rockwell → siemens is unsupported, not a silent success", () => {
      const res = compile({
        sourceLanguage: "rockwell-logix-st",
        targetLanguage: "siemens-scl",
        sourceArtifacts: [{ id: "a", content: AB_SRC }],
      });
      expect(res.ok).toBe(false);
      expect(res.completeness).toBe("failed");
      expect(res.artifacts).toHaveLength(0);
      expect(res.diagnostics.some((d) => d.code === "CAPABILITY_UNSUPPORTED_COMBINATION")).toBe(true);
    });

    it("mitsubishi → mitsubishi (no route) is unsupported", () => {
      const res = compile({
        sourceLanguage: "mitsubishi-gx-st",
        targetLanguage: "mitsubishi-gx-st",
        sourceArtifacts: [{ id: "a", content: MEL_SRC }],
      });
      expect(res.ok).toBe(false);
      expect(res.diagnostics[0].code).toBe("CAPABILITY_UNSUPPORTED_COMBINATION");
    });
  });

  describe("determinism (invariant E)", () => {
    it("identical inputs yield identical hashes", () => {
      const a = compileLegacy(AB_SRC, "ab2mel");
      const b = compileLegacy(AB_SRC, "ab2mel");
      expect(a.hashes.source).toBe(b.hashes.source);
      expect(a.hashes.artifacts).toBe(b.hashes.artifacts);
      expect(a.hashes.diagnostics).toBe(b.hashes.diagnostics);
    });

    it("canonicalJson sorts object keys recursively", () => {
      expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    });

    it("hashValue ignores key order", () => {
      expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }));
    });

    it("compareDiagnostics orders errors before warnings before info", () => {
      const ds: CompilerDiagnostic[] = [
        { code: "Z", severity: "info", message: "i", stage: "emit" },
        { code: "A", severity: "error", message: "e", stage: "emit" },
        { code: "M", severity: "warning", message: "w", stage: "emit" },
      ];
      const sorted = sortDiagnostics(ds);
      expect(sorted.map((d) => d.severity)).toEqual(["error", "warning", "info"]);
    });
  });

  describe("result + artifact + diagnostic schema", () => {
    it("result carries versioned contract fields", () => {
      const res: CompileResult = compileLegacy(AB_SRC, "ab2mel");
      expect(typeof res.compilerVersion).toBe("string");
      expect(res.irSchemaVersion).toBe("1.0.0");
      // AB_SRC routes a TON (canonical, lossy) → an authoritative loss record
      // is present and completeness is review_required (never silently complete).
      expect(res.semanticLosses.length).toBeGreaterThan(0);
      expect(res.semanticLosses.some((l) => l.category === "timers")).toBe(true);
      expect(res.completeness).toBe("review_required");
      expect(["failed", "parsed", "analyzed", "generated", "review_required", "executable_complete"]).toContain(res.completeness);
    });

    it("every generated artifact has a valid kind and non-empty name", () => {
      const res = compileLegacy(AB_SRC, "ab2mel");
      expect(res.artifacts.length).toBeGreaterThan(0);
      for (const art of res.artifacts) {
        expect(ALL_ARTIFACT_KINDS).toContain(art.kind);
        expect(art.name.length).toBeGreaterThan(0);
        expect(isLanguageId(art.language)).toBe(true);
      }
      expect(res.artifacts.some((a) => a.name === "output.st")).toBe(true);
    });

    it("every diagnostic has code, severity, message, and stage", () => {
      const res = compileLegacy(AB_SRC, "ab2mel");
      for (const d of res.diagnostics) {
        expect(typeof d.code).toBe("string");
        expect(["info", "warning", "manual_port", "error"]).toContain(d.severity);
        expect(typeof d.message).toBe("string");
        expect(typeof d.stage).toBe("string");
      }
    });

    it("contract enums are stable and non-empty", () => {
      expect(ALL_LANGUAGE_IDS.length).toBe(7);
      expect(ALL_ARTIFACT_KINDS.length).toBe(5);
      expect(ALL_DISPOSITIONS.length).toBe(6);
    });
  });
});
