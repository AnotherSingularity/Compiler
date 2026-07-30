import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { translate } from "../../../server/translate";
import * as translateMod from "../../../server/translate";
import { compileLegacy } from "../../../server/compiler/compat/legacy-adapter";

/**
 * Stage 8 — the whole-program legacy engine (`translateLegacyForParity`) is
 * isolated as a parity oracle. Ordinary Structured-Text compilation goes through
 * the registry / semantic pipeline / mixed router; production modules must not
 * import the oracle.
 */

// Modules permitted to reference the oracle: it is defined in translate.ts, used
// by the L5K legacy fallback in the bridge, and by the parity harness.
const ALLOWED = new Set([
  "server/translate.ts",
  "server/compiler/compat/legacy-bridge.ts",
  "server/compiler/migration/parity.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === "node_modules" || e === "dist") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("Stage 8 — oracle isolation (import boundary)", () => {
  it("no production module imports translateLegacyForParity except the allowed set", () => {
    const offenders: string[] = [];
    for (const abs of walk(join(process.cwd(), "server"))) {
      const rel = abs.slice(process.cwd().length + 1);
      if (ALLOWED.has(rel)) continue;
      const src = readFileSync(abs, "utf8");
      if (/\btranslateLegacyForParity\b/.test(src)) offenders.push(rel);
    }
    expect(offenders, `unexpected oracle importers: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the server API (routers.ts) imports the PUBLIC translate, not the oracle", () => {
    const src = readFileSync(join(process.cwd(), "server/routers.ts"), "utf8");
    expect(/from\s+["']\.\/translate["']/.test(src)).toBe(true);
    expect(/\btranslateLegacyForParity\b/.test(src)).toBe(false);
  });
});

describe("Stage 8 — runtime proof", () => {
  it("translate() routes canonical families through the pipeline (output differs from the oracle)", () => {
    const src = "y := a + b * 2 - 1;";
    const viaTranslate = translate(src, "ab2mel");
    const viaOracle = translateMod.translateLegacyForParity(src, "ab2mel");
    // The pipeline emits clean canonical ST; the oracle prefixes a provenance
    // comment and fully parenthesizes. Different output ⇒ translate() did not
    // just delegate to the oracle.
    expect(viaTranslate.output).toBe("y := a + b * 2 - 1;");
    expect(viaOracle.output).not.toBe(viaTranslate.output);
  });

  it("compile() and translate() never invoke the whole-program oracle for Structured Text", () => {
    const spy = vi.spyOn(translateMod, "translateLegacyForParity");
    translate("y := a + 1;\nTON(T1);\nPID(Loop1);", "ab2mel");
    translate("d := e + 1;", "mel2ab");
    compileLegacy("y := a + 1;", "ab2mel");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a mixed program reports canonical AND legacy node counts internally", () => {
    const res = compileLegacy("IF x THEN\n  y := 1;\nEND_IF;\nSomeFB(In := x);", "ab2mel");
    expect(res.migration?.engine).toBe("mixed");
    expect(res.migration!.canonicalNodeCount).toBeGreaterThan(0);
    expect(res.migration!.legacyNodeCount).toBeGreaterThan(0);
  });

  it("translate() preserves the legacy TranslationResult shape (output/diagnostics/mapping/labels/stats)", () => {
    const r = translate("VAR\n  x : DINT;\nEND_VAR\nx := 1;", "ab2mel");
    expect(typeof r.output).toBe("string");
    expect(Array.isArray(r.diagnostics)).toBe(true);
    expect(typeof r.mappingYaml).toBe("string");
    expect(typeof r.labelsCsv).toBe("string");
    expect(typeof r.stats.translatedNodes).toBe("number");
    // Canonical ST output; device allocation lives in the mapping artifact.
    expect(r.output).toContain("x : DINT;");
    expect(r.mappingYaml).toContain("device:");
  });

  it("parity tooling invokes the oracle (it is the version-controlled comparison baseline)", () => {
    // The oracle remains callable and deterministic for the parity harness.
    const a = translateMod.translateLegacyForParity("y := a + 1;", "ab2mel").output;
    const b = translateMod.translateLegacyForParity("y := a + 1;", "ab2mel").output;
    expect(a).toBe(b);
    expect(a).toContain("//"); // legacy provenance comment (distinct from canonical)
  });
});
