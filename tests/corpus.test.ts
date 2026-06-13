/**
 * Corpus regression tests — pinned snapshots of translation outcomes
 * for every fixture. Catches any future change that perturbs output.
 *
 * To accept new snapshots after intentional emitter changes:
 *   pnpm vitest run --update tests/corpus.test.ts
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { translate } from "../server/translate";

const FIX_DIR = join(__dirname, "corpus", "fixtures");

type FixtureSpec = { path: string; direction: "ab2mel" | "mel2ab"; label: string };

function collect(): FixtureSpec[] {
  const out: FixtureSpec[] = [];
  for (const f of readdirSync(FIX_DIR)) {
    const p = join(FIX_DIR, f);
    if (f.endsWith(".st") && statSync(p).isFile()) {
      out.push({ path: p, direction: "ab2mel", label: f });
    }
  }
  const melDir = join(FIX_DIR, "mel");
  try {
    for (const f of readdirSync(melDir)) {
      const p = join(melDir, f);
      if (f.endsWith(".st") && statSync(p).isFile()) {
        out.push({ path: p, direction: "mel2ab", label: `mel/${f}` });
      }
    }
  } catch {
    /* no mel fixtures dir */
  }
  return out;
}

const FIXTURES = collect();

describe("Corpus: AB → MEL", () => {
  const abFixtures = FIXTURES.filter((f) => f.direction === "ab2mel");
  for (const f of abFixtures) {
    it(`translates ${f.label}`, () => {
      const src = readFileSync(f.path, "utf-8");
      const result = translate(src, "ab2mel");

      // Translation must succeed (manual-port diagnostics are not failures)
      expect(result.ok || result.diagnostics.every((d) => d.severity !== "ERROR")).toBe(true);
      expect(result.stats.translatedNodes).toBeGreaterThan(0);

      // Pin the *shape* of the result: line counts, diagnostic counts,
      // not the full output (which would churn on cosmetic edits).
      const shape = {
        ok: result.ok,
        inputLines: result.stats.inputLines,
        outputLineRange: bucket(result.stats.outputLines),
        translatedNodes: result.stats.translatedNodes,
        errorCount: result.diagnostics.filter((d) => d.severity === "ERROR").length,
        warnCount: result.diagnostics.filter((d) => d.severity === "WARN").length,
        manualPortCount: result.diagnostics.filter((d) => d.severity === "MANUAL_PORT").length,
        diagnosticCodes: [
          ...new Set(result.diagnostics.map((d) => d.code)),
        ].sort(),
      };
      expect(shape).toMatchSnapshot();
    });
  }
});

describe("Corpus: MEL → AB", () => {
  const melFixtures = FIXTURES.filter((f) => f.direction === "mel2ab");
  for (const f of melFixtures) {
    it(`translates ${f.label}`, () => {
      const src = readFileSync(f.path, "utf-8");
      const result = translate(src, "mel2ab");

      expect(result.ok || result.diagnostics.every((d) => d.severity !== "ERROR")).toBe(true);
      expect(result.stats.translatedNodes).toBeGreaterThan(0);

      const shape = {
        ok: result.ok,
        inputLines: result.stats.inputLines,
        outputLineRange: bucket(result.stats.outputLines),
        translatedNodes: result.stats.translatedNodes,
        errorCount: result.diagnostics.filter((d) => d.severity === "ERROR").length,
        warnCount: result.diagnostics.filter((d) => d.severity === "WARN").length,
        manualPortCount: result.diagnostics.filter((d) => d.severity === "MANUAL_PORT").length,
        diagnosticCodes: [
          ...new Set(result.diagnostics.map((d) => d.code)),
        ].sort(),
      };
      expect(shape).toMatchSnapshot();
    });
  }
});

describe("Corpus: Round-trip AB → MEL → AB", () => {
  const abFixtures = FIXTURES.filter((f) => f.direction === "ab2mel");
  for (const f of abFixtures) {
    it(`round-trips ${f.label} without parse failure`, () => {
      const src = readFileSync(f.path, "utf-8");
      const fwd = translate(src, "ab2mel");
      expect(fwd.stats.translatedNodes).toBeGreaterThan(0);

      // Critical assertion: emitMEL output must be parseable by our own
      // parser. Any parse failure on round-trip = bug in emitMEL emitting
      // invalid IEC ST.
      const back = translate(fwd.output, "mel2ab");
      expect(back.failureReport?.stage).not.toBe("parser");
      expect(back.stats.translatedNodes).toBeGreaterThan(0);
    });
  }
});

// Bucket output line counts so cosmetic edits (a single-line provenance
// change) don't break the snapshot. Adjust granularity here if a fixture
// produces very small or very large output.
function bucket(n: number): string {
  if (n < 10) return "<10";
  if (n < 25) return "10-24";
  if (n < 50) return "25-49";
  if (n < 100) return "50-99";
  if (n < 200) return "100-199";
  return "200+";
}
