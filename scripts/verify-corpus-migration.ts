/**
 * pnpm verify:corpus-migration
 *
 * Runs every corpus fixture through compile() (the registry/hybrid path) and
 * reports per-fixture canonical/legacy node counts. Fails if any fixture routes
 * entirely through legacy (canonical node count 0) — i.e. if mixed routing
 * regressed to whole-program fallback.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { compileLegacy } from "../server/compiler/compat/legacy-adapter";

const dir = join(process.cwd(), "tests/corpus/fixtures");
const rows: Array<{ f: string; engine: string; canon: number; legacy: number }> = [];

function collect(subdir: string, direction: "ab2mel" | "mel2ab") {
  for (const f of readdirSync(subdir).filter((x) => x.endsWith(".st"))) {
    const src = readFileSync(join(subdir, f), "utf8");
    const m = compileLegacy(src, direction).migration!;
    rows.push({ f, engine: m.engine, canon: m.canonicalNodeCount, legacy: m.legacyNodeCount });
  }
}

collect(dir, "ab2mel");
try { collect(join(dir, "mel"), "mel2ab"); } catch { /* no mel subdir */ }

console.log("corpus-migration report");
console.log("───────────────────────");
let bad = 0;
for (const r of rows) {
  const flag = r.canon > 0 ? "OK " : "!! ";
  if (r.canon === 0) bad++;
  console.log(`${flag}${r.f.padEnd(26)} engine=${r.engine.padEnd(9)} canonical=${r.canon} legacy=${r.legacy}`);
}
console.log("───────────────────────");
const mixed = rows.filter((r) => r.engine === "mixed").length;
console.log(`summary: ${rows.length} fixture(s), ${mixed} mixed, ${bad} whole-program-legacy`);

if (bad > 0) {
  console.error(`\nFAIL: ${bad} fixture(s) executed zero canonical nodes (whole-program legacy).`);
  process.exit(1);
}
console.log(`\nPASS: every fixture executes a nonzero canonical node count.`);
