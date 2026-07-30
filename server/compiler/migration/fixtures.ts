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
  // Real multi-branch CASE with comma labels and a range (parser fix, Stage 3).
  { id: "cf_case", family: "control_flow", source: "CASE sel OF\n  0:\n    a := 1;\n  2, 3:\n    a := 2;\n  4..8:\n    a := 3;\nELSE\n  a := 0;\nEND_CASE;" },
  { id: "cf_for", family: "control_flow", source: "FOR i := 0 TO 10 DO\n  sum := sum + i;\nEND_FOR;" },
  { id: "cf_while", family: "control_flow", source: "WHILE go DO\n  n := n - 1;\nEND_WHILE;" },
  { id: "decl_prim", family: "declarations", source: "VAR\n  cnt : DINT;\n  ok : BOOL := 1;\nEND_VAR\ncnt := cnt + 1;" },
  { id: "decl_real", family: "declarations", source: "VAR\n  rate : REAL := 1.5;\nEND_VAR\nrate := rate * 2.0;" },
  // Conversions (canonical_active): TYPE_TO_TYPE reconstructs the exact IEC form.
  { id: "conv_widen", family: "conversions", source: "r := DINT_TO_REAL(n);" },
  { id: "conv_narrow", family: "conversions", source: "n := REAL_TO_INT(r);" },
  { id: "conv_in_expr", family: "conversions", source: "r := DINT_TO_REAL(n) + 0.5;" },
  // Arrays (canonical_active): bounds preserved exactly (no silent 0-rebasing).
  { id: "arr_1based", family: "arrays_structures", source: "VAR\n  buf : ARRAY[1..100] OF DINT;\nEND_VAR\nbuf[1] := 5;" },
  { id: "arr_multidim", family: "arrays_structures", source: "VAR\n  grid : ARRAY[0..9, 0..3] OF INT;\nEND_VAR\ngrid[2, 1] := 7;" },
  // Timers/counters (canonical_active): FB invoke with explicit TODO placeholders
  // (never a fake zero preset); instance fields re-spelled for the target; RES
  // resolved by the operand's actual kind.
  { id: "tmr_on", family: "timers", source: "TON(RunTimer);\nx := RunTimer.DN;" },
  { id: "ctr_up", family: "counters", source: "CTU(MyCtr);\ndone := MyCtr.DN;\ncur := MyCtr.ACC;" },
  { id: "res_typed", family: "counters", source: "CTU(C);\nRES(C);" },
  // Copy/move (canonical_active): target block-move primitive; CPS carries an
  // atomicity loss; LIM lowers to LIMIT.
  { id: "cm_cop", family: "copy_move", source: "COP(srcArr, dstArr, 10);" },
  { id: "cm_cps", family: "copy_move", source: "CPS(srcArr, dstArr, 10);" },
  { id: "cm_lim", family: "copy_move", source: "LIM(lo, val, hi);" },
  // Bit set/clear (canonical_active): AB latch/unlatch → portable boolean assignment.
  { id: "bit_set", family: "bit_operations", source: "OTL(MyBit);" },
  { id: "bit_clear", family: "bit_operations", source: "OTU(MyBit);" },
  // Calls (canonical_active): JSR → portable routine call; plain calls pass through.
  { id: "call_plain", family: "calls", source: "MyFunc(a, b);" },
  { id: "call_jsr", family: "calls", source: "JSR(MySubroutine);" },
];

export const PARITY_FIXTURES: ParityFixture[] = SNIPPETS.flatMap((s) => [
  { ...s, direction: "ab2mel" as const },
  { ...s, direction: "mel2ab" as const },
]);
