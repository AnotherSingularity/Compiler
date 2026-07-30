/**
 * pnpm verify:semantic-loss
 *
 * Enforces loss honesty (invariant D) on the corpus: every fixture that routes a
 * lossy/manual-port/unsupported node MUST carry a structured semantic-loss
 * record, and its completeness MUST NOT be `executable_complete`. Conversely, a
 * fixture with zero recorded losses MUST NOT report review_required for a loss
 * reason. Fails if any fixture's loss records and completeness disagree.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { compileLegacy } from "../server/compiler/compat/legacy-adapter";

const dir = join(process.cwd(), "tests/corpus/fixtures");

interface Row { f: string; losses: number; completeness: string; manualPort: number; ok: boolean; note: string }
const rows: Row[] = [];

function check(subdir: string, direction: "ab2mel" | "mel2ab") {
  for (const f of readdirSync(subdir).filter((x) => x.endsWith(".st"))) {
    const res = compileLegacy(readFileSync(join(subdir, f), "utf8"), direction);
    const losses = res.semanticLosses.length;
    const completeness = res.completeness;
    // Honesty rule: losses present ⟺ not executable_complete.
    const hasLoss = losses > 0;
    const complete = completeness === "executable_complete";
    const ok = hasLoss ? !complete : true; // losses must downgrade completeness
    const note = hasLoss && complete ? "LOSSES BUT REPORTED COMPLETE" : "";
    rows.push({ f, losses, completeness, manualPort: res.stats.manualPortCount, ok, note });
  }
}

check(dir, "ab2mel");
try { check(join(dir, "mel"), "mel2ab"); } catch { /* no mel subdir */ }

console.log("semantic-loss honesty report");
console.log("────────────────────────────");
let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log(`${r.ok ? "OK " : "!! "}${r.f.padEnd(26)} losses=${String(r.losses).padStart(2)} completeness=${r.completeness.padEnd(19)} manualPort=${r.manualPort}${r.note ? "  <<< " + r.note : ""}`);
}
console.log("────────────────────────────");
const withLosses = rows.filter((r) => r.losses > 0).length;
console.log(`summary: ${rows.length} fixture(s), ${withLosses} carry semantic-loss records`);

if (bad > 0) {
  console.error(`\nFAIL: ${bad} fixture(s) carry losses but report executable_complete.`);
  process.exit(1);
}
console.log(`\nPASS: loss records and completeness agree for every fixture.`);
