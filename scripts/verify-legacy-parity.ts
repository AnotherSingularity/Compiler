/**
 * pnpm verify:legacy-parity
 *
 * Compares canonical output against the legacy oracle for every migration
 * fixture. Exits non-zero on any unapproved difference, a non-canonical route
 * for a fixture that should be canonical, or an approval whose pinned hashes no
 * longer match current output.
 */
import { PARITY_FIXTURES } from "../server/compiler/migration/fixtures";
import { PARITY_APPROVALS } from "../server/compiler/migration/approvals";
import { runParity, unapprovedRows } from "../server/compiler/migration/parity";

const rows = runParity(PARITY_FIXTURES, PARITY_APPROVALS);

const byClass = new Map<string, number>();
for (const r of rows) byClass.set(r.classification, (byClass.get(r.classification) ?? 0) + 1);

console.log("legacy-parity report");
console.log("────────────────────");
for (const r of rows) {
  const flag = r.approved ? "OK " : "!! ";
  console.log(`${flag}${r.fixtureId.padEnd(14)} ${r.direction.padEnd(7)} ${r.classification.padEnd(22)} ${r.note}`);
}
console.log("────────────────────");
console.log("summary: " + [...byClass.entries()].map(([k, v]) => `${k}=${v}`).join(", "));

const bad = unapprovedRows(rows);
if (bad.length > 0) {
  console.error(`\nFAIL: ${bad.length} unapproved difference(s).`);
  process.exit(1);
}
console.log(`\nPASS: ${rows.length} fixture(s), 0 unapproved differences.`);
