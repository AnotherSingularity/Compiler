# CHANGELOG — compiler-v1 drop

Date: 2026-06-13
Target: Manus redeploy
Scope: server/compiler + tests/

---

## Summary

Compiler correctness pass. Previous build's MEL→AB direction was a regex
post-process over MEL output; this drop replaces it with a real
AST-walking emitter and pins behavior with a corpus suite that runs
against actual industrial routines (Honda Logix L5K extracts + a
Rockwell PIDE reference).

All work concentrated in:

  - `server/compiler/parser.ts`     (edited)
  - `server/compiler/emitter.ts`    (rewritten)
  - `server/compiler/emitter-ab.ts` (new file)
  - `server/translate.ts`           (wired)
  - `tests/corpus.test.ts`          (new)
  - `tests/corpus/`                 (new fixtures + harnesses)

UI files untouched. Aesthetic state from horizon-v3 carries forward.

---

## Files changed

| File                                  | Status     | Lines |
|---------------------------------------|------------|-------|
| `server/compiler/parser.ts`           | edited     | 595   |
| `server/compiler/emitter.ts`          | rewritten  | 549   |
| `server/compiler/emitter-ab.ts`       | new        | 440   |
| `server/translate.ts`                 | edited     | 266   |
| `tests/corpus.test.ts`                | new        | 127   |
| `tests/corpus/run.ts`                 | new        | 184   |
| `tests/corpus/roundtrip.ts`           | new        | 160   |
| `tests/corpus/fixtures/*.st`          | new        | 6 files |
| `tests/corpus/fixtures/mel/*.st`      | new        | 1 file  |
| `tests/__snapshots__/corpus.test.ts.snap` | new    | 7 snapshots |

---

## Behavioral deltas

### MEL → AB direction

**Before:** `translate.ts` called `emitMEL()` and ran regex replacements
over the output to flip `.Q → .DN`, `.PT → .PRE`, etc. Any MEL-specific
syntax (BMOV, LIMIT, EXPT, FB invoke) passed through untouched. Feeding
real MEL produced AB-shaped gibberish.

**After:** `emitter-ab.ts` walks the AST with AB-specific rewrites:
`BMOV → COP`, `FMOV → FLL`, `LIMIT → LIM`, `EXPT(a,b) → (a ** b)`,
`.Q → .DN`, `.PT → .PRE`, `.ET → .ACC`, `.PV → .PRE`, `.CV → .ACC`.
FB invocations (`Inst(IN := ..., PT := ...)`) decompose into AB form:
settable members (`PRE`) get direct writes, the enable signal wraps the
AB instruction call in an `IF ... THEN TON(Inst); END_IF;`.

### Timer FB invoke

**Before:** `TON(MyTimer)` → `MyTimer(IN := MyTimer_EN, PT := MyTimer_PT);`
Fabricated `_EN` and `_PT` variable names that don't exist anywhere.

**After:** `TON(MyTimer)` → `MyTimer(IN := TODO_MyTimer_enable, PT := MyTimer.PT);`
plus an `INFO` (or `WARN` for retentive) diagnostic. The placeholder is
a real identifier the engineer must wire; it parses cleanly and shows up
in symbol tables.

### Bit-of-word write

**Before:** `StatusWord.0 := Pump_Running;` exploded to a five-line
`IF/BSET/BRST/ELSE/END_IF` block. The Honda 05_HMI fixture inflated
4.4× (46 → 202 lines).

**After:** Direct `StatusWord.0 := Pump_Running;`. GX Works2 ST supports
bit-of-word assignment natively. 05_HMI now goes 46 → 74 lines (1.6×,
only provenance comments add lines).

### COP block-copy

**Before:** Passed through as `COP(src, dst, n);`. Not valid MEL.

**After:** Rewrites to `BMOV(src, dst, n);`. `CPS` (synchronous COP)
also maps to `BMOV` since MEL has no semantic distinction.

### Manual-port placeholder format

**Before:** `LevelControl_SWM (* NEEDS_MANUAL_MAP *)` — block comment
embedded inside an expression. Non-compilable identifier.

**After:** `LevelControl_SWM_MANUAL` (clean identifier) plus a separate
inline note: `LevelControl_SWM_MANUAL := value; (* MANUAL_PORT: ... *)`.
Assignment preserves the RHS operand so it survives round-tripping.

### Provenance comments

**Before:** `// [AB→MEL] src: <input> line N | orig: "text"`
with the orig text passed through `escapeForComment` even though it's a
`//` line comment. Original `(*` and `*)` got mangled to `(\*` and `*\)`.

**After:** `// [AB→MEL] <input>:N | text`. No escaping inside line
comments (they end at newline regardless). Escaping retained where it
matters: inside `(* MANUAL PORT REQUIRED ... *)` block comments.

### Parser: `AT <device>` clause

**Before:** Var decls like `Pump_Cmd AT M1000 : BOOL;` failed parsing.
This is the exact form `emitMEL` produces, meaning our own output
couldn't be re-parsed. Self-inconsistent.

**After:** Optional `AT <addr>` clause consumed between identifier and
colon, per IEC 61131-3. Our own MEL output now round-trips through the
parser cleanly. Also supports `%IX0.0` style direct addresses.

### Parser: type-string reconstruction

**Before:** `ARRAY[0..9] OF INT` tokenized into separate tokens, then
joined without spaces → `ARRAY[0..9]OFINT`. Invalid type spec.

**After:** Space inserted before any token whose first character is a
letter (unless it's the first token). `ARRAY[0..9] OF INT` reconstructs
correctly; punctuation runs like `STRING[80]` stay tight.

### Untranslatable AB instructions

Expanded `UNTRANSLATABLE` map: added `JSR`, `LBL`, `JMP`, `TND`, `SBR`,
`RET` (program flow), kept existing `PID`, `PIDE`, `MSG`, `MAOC`, `MAM`,
`MAJ`, `MSO`, `MAFR` (process + motion). Each emits a structured
`MANUAL_PORT` diagnostic with actionable guidance.

### Instruction rewrite map

New `INSTRUCTION_REWRITES` table in emitter.ts. Each entry maps an AB
instruction name to a MEL-equivalent code fragment:

```
MOV(src, dst)   → dst := src
CLR(x)          → x := 0
COP(s, d, n)    → BMOV(s, d, n)
FLL(v, d, n)    → FMOV(v, d, n)
ABS, SQRT       → ABS, SQRT (IEC standard, same name)
LIM(min, in, max) → LIMIT(min, in, max)
MEQ(src, mask, cmp) → ((src AND mask) = cmp)
SIN, COS, TAN, etc. → IEC math (ASN → ASIN, ACS → ACOS, ATN → ATAN)
```

Mirror table in `emitter-ab.ts` for the reverse direction.

---

## Test coverage delta

**Before:** 20 vitest unit tests, all toy 1–3 line snippets. No corpus
exercise. No round-trip verification.

**After:**

  - 20 original vitest unit tests (unchanged, all still pass)
  - 13 new corpus snapshot tests (6 AB→MEL, 1 MEL→AB, 6 round-trip)
  - 7 pinned snapshots (`tests/__snapshots__/corpus.test.ts.snap`)
  - Standalone iteration harness (`tests/corpus/run.ts`) for fast
    feedback during development
  - Standalone round-trip harness (`tests/corpus/roundtrip.ts`) for
    structural preservation verification

Run all in CI: `pnpm vitest run`

---

## Outcomes on real corpus

| Fixture                       | Direction | Status | Notes                          |
|-------------------------------|-----------|--------|--------------------------------|
| 01_ARRAY100_AVERAGE.st        | AB→MEL    | OK     | clean, no diagnostics          |
| 02_ARRAY2000_AVERAGE.st       | AB→MEL    | OK     | clean                          |
| 03_CHECK_SUM.st               | AB→MEL    | OK     | hex literal + struct.member[i] |
| 04_FEN20_DATA_MOVE.st         | AB→MEL    | WARN   | TONR retentive timer note      |
| 05_HMI_ALARM_MESSAGE.st       | AB→MEL    | OK     | nested FOR + bit-of-word write |
| tank_level_pid_loop.st        | AB→MEL    | MANL   | PID — 10 manual-port diags     |
| mel/runtime_basics.st         | MEL→AB    | MANL   | FB invoke — 2 manual-port diags |

Round-trip AB → MEL → AB:

| Fixture                       | Survival | Notes                              |
|-------------------------------|----------|------------------------------------|
| 01_ARRAY100_AVERAGE.st        | 100%     |                                    |
| 02_ARRAY2000_AVERAGE.st       | 100%     |                                    |
| 03_CHECK_SUM.st               | 100%     |                                    |
| 04_FEN20_DATA_MOVE.st         | 99%      | TONR → TON (asymmetric, expected)  |
| 05_HMI_ALARM_MESSAGE.st       | 100%     |                                    |
| tank_level_pid_loop.st        | 84%      | PID untranslatable both ways       |

All 6 round-trips pass the "MEL output parses cleanly" critical assertion.

---

## What still needs work

See `docs/KNOWN_LIMITATIONS.md` for the full list. Highlights:

  - `MVM` (masked move) — not yet rewritten; needs `dest := (dest AND NOT mask) OR (src AND mask)`
  - `BSL`/`BSR` (shift register) — not yet rewritten
  - `RES(timer)` — not yet handled; should emit `timer.IN := FALSE`
  - String operations (`STOD`, `DTOS`, `MID`, `LEN`, `CONCAT`) — pass through unchanged
  - Parser silently accepts unknown tokens in `parseAtom` (creates fake literal node) — should raise diagnostic

These are bounded gaps. The corpus pins current behavior; adding any of
the above is straightforward (entry in `INSTRUCTION_REWRITES`, snapshot
update).
