/**
 * Round-trip test: AB → MEL → AB. If the compiler is semantically correct,
 * key syntactic structures should survive the round trip even if comments
 * and manual-port placeholders don't.
 *
 * We don't expect identity (the emitter adds provenance comments, strips
 * AT clauses, etc.) — we expect *structural* preservation: assignments,
 * IF/CASE/FOR control flow, identifiers, literals, arithmetic.
 *
 * Run with:  pnpm tsx tests/corpus/roundtrip.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { translate } from "../../server/translate";

const FIX_DIR = join(__dirname, "fixtures");

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

// Extract structural signature of source: identifiers, literals, keywords.
// Strip comments (both // and (* ... *)), strip whitespace, strip provenance.
function signature(src: string): string[] {
  // Remove block comments
  let s = src.replace(/\(\*[\s\S]*?\*\)/g, " ");
  // Remove line comments
  s = s.replace(/\/\/[^\n]*/g, " ");
  // Tokenize into identifiers + numbers + operators
  const tokens = s.match(/[A-Za-z_][A-Za-z0-9_]*|[0-9]+(?:\.[0-9]+)?|:=|<>|<=|>=|\.\.|[+\-*/<>=()\[\]:;,.&]/g) || [];
  return tokens.filter((t) => t.length > 0);
}

// Identifiers worth tracking: skip super-common keywords that obscure diffs
const SKIP = new Set([
  "IF", "THEN", "ELSE", "ELSIF", "END_IF", "FOR", "TO", "BY", "DO",
  "END_FOR", "WHILE", "END_WHILE", "REPEAT", "UNTIL", "END_REPEAT",
  "VAR", "END_VAR", "AT", "OF",
  "TRUE", "FALSE", "NOT", "AND", "OR", "XOR",
  ":=", ";", ":", ",", ".", "(", ")", "[", "]",
  "+", "-", "*", "/", "<", ">", "=", "<>", "<=", ">=", "&",
]);

function meaningfulIdents(tokens: string[]): Set<string> {
  return new Set(tokens.filter((t) => !SKIP.has(t) && !/^\d/.test(t)));
}

function compare(a: string[], b: string[]) {
  const aSet = meaningfulIdents(a);
  const bSet = meaningfulIdents(b);
  const lost = [...aSet].filter((t) => !bSet.has(t));
  const gained = [...bSet].filter((t) => !aSet.has(t));
  return { lost, gained, original: aSet.size, final: bSet.size };
}

console.log(`\n${ANSI.bold}round-trip · AB → MEL → AB${ANSI.reset}\n`);

const fixtures = readdirSync(FIX_DIR)
  .filter((f) => f.endsWith(".st"))
  .sort();

let pass = 0;
let fail = 0;

for (const fixture of fixtures) {
  const src = readFileSync(join(FIX_DIR, fixture), "utf-8");

  // Forward: AB → MEL
  const fwd = translate(src, "ab2mel");
  if (!fwd.ok || !fwd.output) {
    console.log(`  ${ANSI.red}FAIL${ANSI.reset}  ${fixture}  forward translation failed`);
    fail++;
    continue;
  }

  // Backward: MEL → AB
  const back = translate(fwd.output, "mel2ab");
  if (!back.ok || !back.output) {
    console.log(`  ${ANSI.red}FAIL${ANSI.reset}  ${fixture}  backward translation failed`);
    fail++;
    continue;
  }

  const origTokens = signature(src);
  const finalTokens = signature(back.output);
  const cmp = compare(origTokens, finalTokens);

  // Things expected to be lost: PID parameter names introduced as comment
  // bodies, MANUAL placeholder suffixes that didn't exist in the original.
  // Filter known-acceptable lost tokens.
  const manualPortInstances = new Set<string>();
  // A manual port occurred if ANY forward diagnostic is MANUAL_PORT. (The
  // canonical pipeline reports these as structured loss-derived diagnostics
  // and propagated legacy-fragment diagnostics; the whole-program oracle used a
  // prose "instance member: X" form. Detect the condition robustly, then still
  // try to pull instance names out of the prose form where present.)
  const hasManualPort = fwd.diagnostics.some((d) => d.severity === "MANUAL_PORT");
  for (const d of fwd.diagnostics) {
    if (d.severity === "MANUAL_PORT") {
      const m = d.message.match(/instance(?: member)?:\s*([A-Za-z_][A-Za-z0-9_]*)/);
      if (m) manualPortInstances.add(m[1]);
    }
  }

  const realLost = cmp.lost.filter((t) => {
    // _MANUAL suffix placeholders are expected when source contained PID,
    // because the round-trip can't restore the original member name.
    if (t.endsWith("_MANUAL")) return false;
    // Lost identifiers ending in _PT (timer preset member synth) — expected
    if (t === "PT" || t === "PRE") return false;
    // Lost AB instruction names that have one-way mappings (TONR → TON,
    // CPS → CPS, etc.). These are expected info-level losses.
    if (["TONR", "RTO", "CPS", "FLL", "CPT"].includes(t)) return false;
    // Tokens that belong to a manual-ported instance are documented loss
    if (manualPortInstances.has(t)) return false;
    // PID/PIDE/MSG-specific member names that only existed in the comment
    // body of a MANUAL_PORT block
    if (hasManualPort && ["SP", "PV", "OUT", "Kp", "Ki", "Kd", "SWM", "SO", "DB", "ERR", "BIAS", "MAXO", "MINO", "PID", "PIDE", "MSG"].includes(t)) return false;
    return true;
  });

  // Things expected to be gained: instructions we rewrote (COP→BMOV→COP
  // round-trips fine, but MANUAL flag tokens, RES, IN/PT placeholders).
  const realGained = cmp.gained.filter((t) => {
    if (["TODO", "RES", "MANUAL", "PORT", "REQUIRED", "TON", "CTU", "CTUD"].includes(t)) return false;
    return true;
  });

  const survivalRate = origTokens.length
    ? (1 - cmp.lost.length / new Set(origTokens.filter((t) => !SKIP.has(t))).size) * 100
    : 100;

  const badge = realLost.length === 0
    ? `${ANSI.green}PASS${ANSI.reset}`
    : realLost.length <= 3
      ? `${ANSI.yellow}SOFT${ANSI.reset}`
      : `${ANSI.red}FAIL${ANSI.reset}`;

  if (realLost.length === 0) pass++;
  else fail++;

  console.log(
    `  ${badge}  ${ANSI.bold}${fixture}${ANSI.reset}  ${ANSI.dim}${cmp.original} → ${cmp.final} idents, ${survivalRate.toFixed(0)}% survival${ANSI.reset}`,
  );
  if (realLost.length > 0) {
    console.log(`        ${ANSI.gray}lost: ${realLost.slice(0, 10).join(", ")}${realLost.length > 10 ? "…" : ""}${ANSI.reset}`);
  }
  if (realGained.length > 0 && realLost.length === 0) {
    console.log(`        ${ANSI.gray}new (ok): ${realGained.slice(0, 6).join(", ")}${realGained.length > 6 ? "…" : ""}${ANSI.reset}`);
  }
}

console.log(
  `\n${ANSI.bold}round-trip summary${ANSI.reset}  ${pass}/${pass + fail} passed\n`,
);
if (fail > 0) process.exit(1);
