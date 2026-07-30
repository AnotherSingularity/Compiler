/**
 * pnpm verify:corpus-migration
 *
 * Runs every corpus fixture through compile() (the registry/hybrid path) and
 * enforces a version-controlled non-regression FLOOR (tests/corpus/coverage-floor.json).
 * It fails if any fixture:
 *   - routes entirely through legacy (canonical node count 0),
 *   - drops below its recorded minimum canonical node count,
 *   - regresses to whole-program legacy routing (engine "legacy"),
 *   - has unbalanced node accounting (canonical + legacy != translatedNodes),
 *   - loses a required semantic-loss record (below the recorded minimum),
 *   - is present in the corpus but missing from the floor (must be pinned).
 * No wildcard coverage approvals — every fixture is pinned explicitly.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { compileLegacy, type LegacyDirection } from "../server/compiler/compat/legacy-adapter";

const dir = join(process.cwd(), "tests/corpus/fixtures");
const floor = JSON.parse(readFileSync(join(process.cwd(), "tests/corpus/coverage-floor.json"), "utf8")).fixtures as Record<
  string,
  { direction: LegacyDirection; minCanonical: number; engine: string; minLosses: number }
>;

interface Row {
  f: string; direction: string; engine: string; canon: number; legacy: number; total: number;
  losses: number; reviewRequired: number; completeness: string; failures: string[];
}
const rows: Row[] = [];

function collect(subdir: string, direction: LegacyDirection) {
  for (const f of readdirSync(subdir).filter((x) => x.endsWith(".st"))) {
    const res = compileLegacy(readFileSync(join(subdir, f), "utf8"), direction);
    const m = res.migration!;
    const total = res.stats.translatedNodes;
    const reviewRequired = res.semanticLosses.filter((l) => l.disposition !== "exact" && l.disposition !== "equivalent_lowering").length;
    const failures: string[] = [];
    const fl = floor[f];
    if (!fl) failures.push("NOT IN COVERAGE FLOOR (must be pinned)");
    else {
      if (m.canonicalNodeCount < fl.minCanonical) failures.push(`canonical ${m.canonicalNodeCount} < floor ${fl.minCanonical}`);
      if (fl.engine === "canonical" && m.engine !== "canonical") failures.push(`engine ${m.engine} != floor ${fl.engine}`);
      if (fl.engine === "mixed" && m.engine === "legacy") failures.push(`engine regressed to whole-program legacy`);
      if (res.semanticLosses.length < fl.minLosses) failures.push(`losses ${res.semanticLosses.length} < floor ${fl.minLosses} (dropped record)`);
    }
    if (m.canonicalNodeCount === 0) failures.push("zero canonical nodes (whole-program legacy)");
    if (m.engine === "legacy") failures.push("engine=legacy (whole-program legacy routing returned)");
    if (m.canonicalNodeCount + m.legacyNodeCount !== total) failures.push(`node accounting imbalance: ${m.canonicalNodeCount}+${m.legacyNodeCount} != ${total}`);
    rows.push({ f, direction, engine: m.engine, canon: m.canonicalNodeCount, legacy: m.legacyNodeCount, total, losses: res.semanticLosses.length, reviewRequired, completeness: res.completeness, failures });
  }
}

collect(dir, "ab2mel");
try { collect(join(dir, "mel"), "mel2ab"); } catch { /* no mel subdir */ }

console.log("corpus-migration report (with coverage floor)");
console.log("──────────────────────────────────────────────");
let bad = 0;
for (const r of rows) {
  const ok = r.failures.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? "OK " : "!! "}${r.f.padEnd(26)} engine=${r.engine.padEnd(9)} canon=${String(r.canon).padStart(3)} legacy=${String(r.legacy).padStart(2)} total=${String(r.total).padStart(3)} losses=${r.losses} review=${r.reviewRequired} ${r.completeness}`);
  for (const fail of r.failures) console.log(`     <<< ${fail}`);
}
console.log("──────────────────────────────────────────────");
const mixed = rows.filter((r) => r.engine === "mixed").length;
console.log(`summary: ${rows.length} fixture(s), ${mixed} mixed, ${bad} below-floor/regressed`);

// Every floor fixture must be present in the corpus.
for (const f of Object.keys(floor)) {
  if (!rows.some((r) => r.f === f)) { console.error(`\nFAIL: floor fixture ${f} is missing from the corpus.`); process.exit(1); }
}

if (bad > 0) {
  console.error(`\nFAIL: ${bad} fixture(s) violate the coverage floor.`);
  process.exit(1);
}
console.log(`\nPASS: every fixture meets its coverage floor; node accounting balances; no whole-program-legacy routing.`);
