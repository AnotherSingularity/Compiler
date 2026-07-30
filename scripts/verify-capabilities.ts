/**
 * pnpm verify:capabilities
 *
 * Proves the per-target capability manifests are AUTHORITATIVE and CONSISTENT:
 * every vendor mnemonic the compiler can normalize into a canonical operation
 * must map to a capability key, that key must be declared in the target
 * manifest, and the manifest disposition MUST equal the disposition
 * operation-normalization assigns. This prevents the manifest and the pipeline
 * from silently drifting apart. Intentionally-unmapped operations (inline
 * expressions, family-resolved resets) are reported but not required.
 *
 * The mitsubishi (ab2mel) target is enforced strictly (fail on gap or
 * mismatch). The rockwell (mel2ab) target is enforced for consistency where it
 * declares a rule; its coverage gaps are reported, since MEL source rarely emits
 * AB-mnemonic operations and completing that manifest is tracked separately.
 */
import { mnemonicRule } from "../server/compiler/semantic/operation-normalization";
import { IR_TO_CAPABILITY_KEY, UNMAPPED_IR_OPERATIONS } from "../server/compiler/capability/evaluator";
import { manifestForTarget } from "../server/compiler/capability/manifests";
import type { SemanticOperationKind as IrOperationKind } from "../server/compiler/ir/operations";
import type { TranslationDisposition } from "../server/compiler/contracts/ids";
import type { CapabilityManifest } from "../server/compiler/contracts/capability";

// Every mnemonic the normalizer recognizes → its canonical op + disposition.
const MNEMONICS = ["TON", "TOF", "RTO", "TONR", "CTU", "CTD", "COP", "BMOV", "CPS", "MVM", "LIM", "LIMIT", "MSG", "PID", "PIDE", "JSR"];

interface OpExpectation { irKind: IrOperationKind; disposition: TranslationDisposition }
const expectations = new Map<IrOperationKind, TranslationDisposition>();
for (const m of MNEMONICS) {
  const rule = mnemonicRule(m);
  if (rule) expectations.set(rule.operation, rule.disposition);
}

interface Issue { target: string; op: string; kind: "unmapped" | "undeclared" | "mismatch"; detail: string }
const issues: Issue[] = [];
const rows: string[] = [];

function checkTarget(target: "mitsubishi-gx-st" | "rockwell-logix-st", strict: boolean) {
  const manifest = manifestForTarget(target) as CapabilityManifest;
  rows.push(`\n[target ${target}] (${strict ? "strict" : "consistency-only"})`);
  for (const [irKind, disposition] of [...expectations.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (UNMAPPED_IR_OPERATIONS.has(irKind)) {
      rows.push(`  ·  ${irKind.padEnd(24)} intentionally unmapped (inline/expression family)`);
      continue;
    }
    const key = IR_TO_CAPABILITY_KEY[irKind];
    if (!key) {
      rows.push(`  !! ${irKind.padEnd(24)} NO capability key (forgotten mapping)`);
      issues.push({ target, op: irKind, kind: "unmapped", detail: "no capability key in IR_TO_CAPABILITY_KEY" });
      continue;
    }
    const rule = manifest.operations[key];
    if (!rule) {
      rows.push(`  ${strict ? "!!" : "~ "} ${irKind.padEnd(24)} → ${key.padEnd(22)} UNDECLARED in manifest`);
      if (strict) issues.push({ target, op: irKind, kind: "undeclared", detail: `${key} not declared` });
      continue;
    }
    if (rule.disposition !== disposition) {
      rows.push(`  !! ${irKind.padEnd(24)} → ${key.padEnd(22)} disposition ${rule.disposition} ≠ normalization ${disposition}`);
      issues.push({ target, op: irKind, kind: "mismatch", detail: `manifest ${rule.disposition} vs normalization ${disposition}` });
      continue;
    }
    rows.push(`  OK ${irKind.padEnd(24)} → ${key.padEnd(22)} ${rule.disposition}`);
  }
}

checkTarget("mitsubishi-gx-st", true);
checkTarget("rockwell-logix-st", false);

console.log("capability consistency report");
console.log("─────────────────────────────");
console.log(rows.join("\n"));
console.log("\n─────────────────────────────");
console.log(`summary: ${expectations.size} normalized operation(s), ${issues.length} blocking issue(s)`);

if (issues.length > 0) {
  console.error(`\nFAIL: capability manifest is not authoritative:`);
  for (const i of issues) console.error(`  - [${i.target}] ${i.op}: ${i.kind} — ${i.detail}`);
  process.exit(1);
}
console.log(`\nPASS: every emittable operation is declared and consistent (strict target) / consistent where declared (reverse target).`);
