import { describe, it, expect } from "vitest";
import { translate } from "../../server/translate";
import {
  LanguageRegistry,
  RegistryError,
  createDefaultRegistry,
  compileWithRegistry,
} from "../../server/compiler/registry";
import {
  rockwellLogixStFrontend,
  rockwellLogixStBackend,
  rockwellL5kFrontend,
} from "../../server/compiler/languages/rockwell";
import { mitsubishiGxStFrontend, mitsubishiGxStBackend } from "../../server/compiler/languages/mitsubishi";
import { compileLegacy } from "../../server/compiler/compat/legacy-adapter";
import { isSourceEmitCapable, operationSupport } from "../../server/compiler/contracts";

const AB_SRC = "IF x > 0 THEN\n  y := 1;\nEND_IF;\nSomeFB(In := x);";
const MEL_SRC = "RunTimer(IN := start, PT := T#5s);\nD100 := D200 + 1;";
const L5K_SRC =
  'IE_VER := 2.25;\nCONTROLLER Demo (ProcessorType := "x")\n  PROGRAM Main\n    ROUTINE R\n      N: XIC(a)OTE(b) ;\n    END_ROUTINE\n  END_PROGRAM\nEND_CONTROLLER';

describe("Phase 2 — language registry + plugins", () => {
  describe("registry mechanics", () => {
    it("registers and lists frontends/backends in deterministic id order", () => {
      const reg = createDefaultRegistry();
      const inv = reg.inventory();
      expect(inv.frontends).toEqual([...inv.frontends].sort());
      expect(inv.backends).toEqual([...inv.backends].sort());
      expect(inv.frontends).toContain("rockwell-logix-st");
      expect(inv.frontends).toContain("rockwell-l5k");
      expect(inv.frontends).toContain("mitsubishi-gx-st");
      expect(inv.backends).toEqual(["mitsubishi-gx-st", "rockwell-logix-st"]);
    });

    it("duplicate frontend registration fails deterministically", () => {
      const reg = new LanguageRegistry();
      reg.registerFrontend(rockwellLogixStFrontend);
      expect(() => reg.registerFrontend(rockwellLogixStFrontend)).toThrow(RegistryError);
    });

    it("duplicate backend registration fails deterministically", () => {
      const reg = new LanguageRegistry();
      reg.registerBackend(mitsubishiGxStBackend);
      expect(() => reg.registerBackend(mitsubishiGxStBackend)).toThrow(RegistryError);
    });

    it("inventory is stable across construction (determinism)", () => {
      expect(createDefaultRegistry().inventory()).toEqual(createDefaultRegistry().inventory());
    });
  });

  describe("detection (confidence + evidence, fail closed on ambiguity)", () => {
    it("detects L5K with high confidence and evidence", () => {
      const reg = createDefaultRegistry();
      const out = reg.detect({ id: "a", content: L5K_SRC });
      expect(out.language).toBe("rockwell-l5k");
      const l5k = out.candidates.find((c) => c.language === "rockwell-l5k");
      expect(l5k!.confidence).toBeGreaterThan(0.9);
      expect(l5k!.evidence.length).toBeGreaterThan(0);
    });

    it("resolves Mitsubishi ST when device addressing is present", () => {
      const reg = createDefaultRegistry();
      const out = reg.detect({ id: "a", content: MEL_SRC });
      expect(out.language).toBe("mitsubishi-gx-st");
    });

    it("returns ambiguous (no pick) for plain dialect-neutral ST", () => {
      const reg = createDefaultRegistry();
      const out = reg.detect({ id: "a", content: "IF a THEN\n  b := c;\nEND_IF;" });
      expect(out.language).toBeNull();
      expect(out.reason).toBe("ambiguous");
      expect(out.candidates.length).toBeGreaterThanOrEqual(2);
    });

    it("returns no_candidates for non-PLC text", () => {
      const reg = createDefaultRegistry();
      const out = reg.detect({ id: "a", content: "the quick brown fox" });
      expect(out.language).toBeNull();
      expect(out.reason).toBe("no_candidates");
    });
  });

  describe("orchestrator routing (no ab2mel/mel2ab)", () => {
    it("routes an explicit Rockwell→Mitsubishi mixed request through hybrid (IF canonical, FB invoke legacy)", () => {
      const reg = createDefaultRegistry();
      const res = compileWithRegistry(
        { sourceLanguage: "rockwell-logix-st", targetLanguage: "mitsubishi-gx-st", sourceArtifacts: [{ id: "<input>", content: AB_SRC }] },
        reg,
      );
      expect(res.migration?.engine).toBe("mixed");
      const out = res.artifacts.find((a) => a.name === "output.st")?.content ?? "";
      expect(out).toContain("IF x > 0 THEN");
      expect(res.migration?.canonicalNodeCount ?? 0).toBeGreaterThan(0);
      expect(res.migration?.legacyNodeCount ?? 0).toBeGreaterThan(0);
      expect(res.sourceLanguage).toBe("rockwell-logix-st");
    });

    it("auto-detects the source for an L5K request and emits", () => {
      const reg = createDefaultRegistry();
      const res = compileWithRegistry(
        { sourceLanguage: "auto", targetLanguage: "mitsubishi-gx-st", sourceArtifacts: [{ id: "<input>", content: L5K_SRC }] },
        reg,
      );
      expect(res.sourceLanguage).toBe("rockwell-l5k");
      expect(res.artifacts.some((a) => a.name === "output.st")).toBe(true);
    });

    it("fails closed on an ambiguous auto source", () => {
      const reg = createDefaultRegistry();
      const res = compileWithRegistry(
        { sourceLanguage: "auto", targetLanguage: "mitsubishi-gx-st", sourceArtifacts: [{ id: "<input>", content: "IF a THEN\n b := c;\nEND_IF;" }] },
        reg,
      );
      expect(res.ok).toBe(false);
      expect(res.diagnostics.some((d) => d.code === "DETECTION_AMBIGUOUS")).toBe(true);
    });

    it("fails closed when the target has no backend", () => {
      const reg = createDefaultRegistry();
      const res = compileWithRegistry(
        { sourceLanguage: "rockwell-logix-st", targetLanguage: "siemens-scl", sourceArtifacts: [{ id: "<input>", content: AB_SRC }] },
        reg,
      );
      expect(res.ok).toBe(false);
      expect(res.diagnostics.some((d) => d.code === "CAPABILITY_UNSUPPORTED_COMBINATION")).toBe(true);
      expect(res.artifacts).toHaveLength(0);
    });
  });

  describe("legacy adapter now routes through the registry (equivalence preserved)", () => {
    it("compileLegacy ab2mel routes the mixed program through hybrid", () => {
      const res = compileLegacy(AB_SRC, "ab2mel");
      expect(res.migration?.engine).toBe("mixed");
      expect((res.migration?.canonicalNodeCount ?? 0)).toBeGreaterThan(0);
      expect((res.migration?.legacyNodeCount ?? 0)).toBeGreaterThan(0);
    });

    it("compileLegacy mel2ab routes the mixed program through hybrid (D100 assignment canonical, FB legacy)", () => {
      const res = compileLegacy(MEL_SRC, "mel2ab");
      expect(res.migration?.engine).toBe("mixed");
      const out = res.artifacts.find((a) => a.name === "output.st")?.content ?? "";
      expect(out).toContain("D100 := D200 + 1;");
    });
  });

  describe("plugin surface", () => {
    it("backends expose an inspectable capability manifest", () => {
      const cap = mitsubishiGxStBackend.capabilities();
      expect(cap.language).toBe("mitsubishi-gx-st");
      expect(operationSupport(cap, "PIDControl").disposition).toBe("manual_port");
      expect(operationSupport(cap, "MotionCommand").disposition).toBe("unsupported");
      expect(operationSupport(cap, "Assignment").disposition).toBe("exact");
    });

    it("built-in backends are source-emit capable with declared sources", () => {
      expect(isSourceEmitCapable(mitsubishiGxStBackend)).toBe(true);
      expect(mitsubishiGxStBackend.legacyEmitSources()).toContain("rockwell-logix-st");
      expect(rockwellLogixStBackend.legacyEmitSources()).toContain("mitsubishi-gx-st");
    });

    it("frontends declare supported artifact kinds", () => {
      expect(rockwellLogixStFrontend.supportedArtifacts).toContain("structured_text");
      expect(rockwellL5kFrontend.supportedArtifacts).toContain("project_exchange");
      expect(mitsubishiGxStFrontend.supportedArtifacts).toContain("structured_text");
    });

    it("frontends parse to a program carrying the ir schema version", () => {
      const p = rockwellLogixStFrontend.parse([{ id: "a", content: AB_SRC }], {});
      expect(p.ok).toBe(true);
      expect(p.program?.irSchemaVersion).toBe("1.0.0");
      const l5k = rockwellL5kFrontend.parse([{ id: "a", content: L5K_SRC }], {});
      expect(l5k.program?.units.length).toBeGreaterThan(0);
    });
  });
});
