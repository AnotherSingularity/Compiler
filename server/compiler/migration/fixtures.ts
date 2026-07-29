/**
 * Migration parity fixtures — small ST snippets exercising the migrated
 * families (expressions, assignments, control_flow) in both directions.
 */
import type { ParityFixture } from "./parity";

const SNIPPETS: Array<{ id: string; family: string; source: string }> = [
  { id: "expr_arith", family: "expressions", source: "y := a + b * 2 - 1;" },
  { id: "expr_logic", family: "expressions", source: "flag := a AND b OR NOT c;" },
  { id: "expr_cmp", family: "expressions", source: "ok := (x >= 10) AND (x <= 20);" },
  { id: "assign_member", family: "assignments", source: "obj.field := arr[3];" },
  { id: "cf_if", family: "control_flow", source: "IF x > 0 THEN\n  y := 1;\nELSIF x < 0 THEN\n  y := 0 - 1;\nELSE\n  y := 0;\nEND_IF;" },
  // Single-branch CASE: the baseline ST parser does not correctly delimit
  // multi-branch CASE bodies (a pre-existing limitation — see KNOWN_LIMITATIONS
  // / BUILDOUT_STATUS). Parity stays within what the parser handles today.
  { id: "cf_case", family: "control_flow", source: "CASE sel OF\n  1:\n    a := 1;\nELSE\n  a := 0;\nEND_CASE;" },
  { id: "cf_for", family: "control_flow", source: "FOR i := 0 TO 10 DO\n  sum := sum + i;\nEND_FOR;" },
  { id: "cf_while", family: "control_flow", source: "WHILE go DO\n  n := n - 1;\nEND_WHILE;" },
];

export const PARITY_FIXTURES: ParityFixture[] = SNIPPETS.flatMap((s) => [
  { ...s, direction: "ab2mel" as const },
  { ...s, direction: "mel2ab" as const },
]);
