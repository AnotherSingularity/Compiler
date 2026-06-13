/**
 * Corpus runner — direct compiler invocation against fixtures.
 *
 * Usage:  pnpm tsx tests/corpus/run.ts                 (all, both directions)
 *         pnpm tsx tests/corpus/run.ts tank             (filter by substring)
 *         pnpm tsx tests/corpus/run.ts --verbose tank
 *         pnpm tsx tests/corpus/run.ts --direction=ab2mel    (one direction)
 *
 * Fixtures in tests/corpus/fixtures/         → ab2mel  (treated as AB ST)
 * Fixtures in tests/corpus/fixtures/mel/     → mel2ab  (treated as MEL ST)
 *
 * This is the fast iteration loop while the compiler is unstable. Once
 * outcomes stabilize, the cases get pinned into vitest snapshots.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { translate } from "../../server/translate";

const FIX_DIR = join(__dirname, "fixtures");
const args = process.argv.slice(2);
const verbose = args.includes("--verbose") || args.includes("-v");
const dirArg = args.find((a) => a.startsWith("--direction="));
const onlyDir = dirArg ? dirArg.split("=")[1] : null;
const filters = args.filter((a) => !a.startsWith("-"));

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

type Direction = "ab2mel" | "mel2ab";
type Fixture = { path: string; direction: Direction; label: string };

function collectFixtures(): Fixture[] {
  const out: Fixture[] = [];
  // AB ST fixtures live at the top of FIX_DIR
  for (const f of readdirSync(FIX_DIR)) {
    const p = join(FIX_DIR, f);
    if (f.endsWith(".st") && statSync(p).isFile()) {
      out.push({ path: p, direction: "ab2mel", label: f });
    }
  }
  // MEL ST fixtures live under FIX_DIR/mel
  const melDir = join(FIX_DIR, "mel");
  try {
    for (const f of readdirSync(melDir)) {
      const p = join(melDir, f);
      if (f.endsWith(".st") && statSync(p).isFile()) {
        out.push({ path: p, direction: "mel2ab", label: `mel/${f}` });
      }
    }
  } catch {
    // No MEL fixtures directory — that's fine
  }
  return out.sort((a, b) => {
    if (a.direction !== b.direction) {
      // ab2mel first, mel2ab second
      return a.direction === "ab2mel" ? -1 : 1;
    }
    return a.label.localeCompare(b.label);
  });
}

const FIXTURES = collectFixtures()
  .filter((f) => onlyDir === null || f.direction === onlyDir)
  .filter((f) => filters.length === 0 || filters.some((q) => f.label.includes(q)));

if (FIXTURES.length === 0) {
  console.error(`no fixtures match ${filters.join(", ")}`);
  process.exit(2);
}

type Outcome = {
  fixture: string;
  direction: Direction;
  ok: boolean;
  translatedNodes: number;
  inputLines: number;
  outputLines: number;
  parseFailed: boolean;
  errors: number;
  warns: number;
  infos: number;
  manualPorts: number;
  firstIssue?: string;
  output: string;
};

function run(fixture: Fixture): Outcome {
  const src = readFileSync(fixture.path, "utf-8");
  const result = translate(src, fixture.direction);

  const errors = result.diagnostics.filter((d) => d.severity === "ERROR").length;
  const warns = result.diagnostics.filter((d) => d.severity === "WARN").length;
  const infos = result.diagnostics.filter((d) => d.severity === "INFO").length;
  const manualPorts = result.diagnostics.filter((d) => d.severity === "MANUAL_PORT").length;
  const firstError = result.diagnostics.find((d) => d.severity === "ERROR");
  const firstMP = result.diagnostics.find((d) => d.severity === "MANUAL_PORT");
  const firstW = result.diagnostics.find((d) => d.severity === "WARN");
  const firstIssue =
    firstError ? `ERROR @${firstError.line}: ${firstError.message}` :
    firstMP ? `MANUAL @${firstMP.line}: ${firstMP.message}` :
    firstW ? `WARN @${firstW.line}: ${firstW.message}` :
    undefined;

  return {
    fixture: fixture.label,
    direction: fixture.direction,
    ok: result.ok,
    translatedNodes: result.stats.translatedNodes,
    inputLines: result.stats.inputLines,
    outputLines: result.stats.outputLines,
    parseFailed: result.failureReport?.stage === "parser",
    errors,
    warns,
    infos,
    manualPorts,
    firstIssue,
    output: result.output,
  };
}

function statusBadge(o: Outcome): string {
  if (o.parseFailed) return `${ANSI.red}PARSE${ANSI.reset}`;
  if (o.errors > 0) return `${ANSI.red}ERR  ${ANSI.reset}`;
  if (o.translatedNodes === 0) return `${ANSI.red}EMPTY${ANSI.reset}`;
  if (o.manualPorts > 0) return `${ANSI.yellow}MANL ${ANSI.reset}`;
  if (o.warns > 0) return `${ANSI.cyan}WARN ${ANSI.reset}`;
  return `${ANSI.green}OK   ${ANSI.reset}`;
}

function fmt(s: string | undefined, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.substring(0, n - 1) + "…";
}

console.log(
  `\n${ANSI.bold}corpus harness${ANSI.reset}  ·  ${FIXTURES.length} fixture(s)  ·  ${verbose ? "verbose" : "summary"}\n`,
);

const results: Outcome[] = [];
let lastDir: Direction | null = null;
for (const fixture of FIXTURES) {
  if (fixture.direction !== lastDir) {
    console.log(
      `${ANSI.dim}── ${fixture.direction === "ab2mel" ? "AB → MEL" : "MEL → AB"} ──${ANSI.reset}`,
    );
    lastDir = fixture.direction;
  }
  const o = run(fixture);
  results.push(o);

  const head = `  ${statusBadge(o)}  ${ANSI.bold}${basename(o.fixture)}${ANSI.reset}`;
  const stats = `${ANSI.dim}${o.inputLines}→${o.outputLines} ln · ${o.translatedNodes} nodes${ANSI.reset}`;
  const diags = `${o.errors ? `${ANSI.red}${o.errors}e${ANSI.reset} ` : ""}${o.manualPorts ? `${ANSI.yellow}${o.manualPorts}mp${ANSI.reset} ` : ""}${o.warns ? `${ANSI.cyan}${o.warns}w${ANSI.reset} ` : ""}${o.infos ? `${ANSI.gray}${o.infos}i${ANSI.reset}` : ""}`;
  console.log(`${head}  ${stats}  ${diags}`);
  if (o.firstIssue) {
    console.log(`        ${ANSI.gray}${fmt(o.firstIssue, 110)}${ANSI.reset}`);
  }
  if (verbose) {
    console.log(`\n${ANSI.dim}---- output ----${ANSI.reset}`);
    console.log(o.output);
    console.log(`${ANSI.dim}---- end ----${ANSI.reset}\n`);
  }
}

// Summary
const okCount = results.filter((r) => r.ok && r.translatedNodes > 0).length;
const failCount = results.length - okCount;
console.log(
  `\n${ANSI.bold}summary${ANSI.reset}  ${okCount}/${results.length} translated, ${failCount} failed/empty\n`,
);
if (failCount > 0) process.exit(1);

