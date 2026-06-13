# TESTING — test infrastructure

Three layers of tests, each with a different purpose.

---

## Layer 1: vitest unit tests (`tests/translate.test.ts`)

**20 tests**, toy 1–3 line snippets. Cover the basic behavioral
contract: `TON(inst)` produces an FB invocation, `.DN` rewrites to
`.Q`, `MANUAL_PORT` fires for PID/MSG/motion, allocator produces device
addresses, etc.

These exist from before the compiler-v1 work. They've been preserved
unchanged — every refactor of the emitter had to keep them green.
Treat them as the **lower-bound regression net**: any change that
breaks these means the basic contract changed and probably shouldn't.

Run: `pnpm vitest run tests/translate.test.ts`

---

## Layer 2: corpus snapshot tests (`tests/corpus.test.ts`)

**13 tests**, derived from the actual fixtures in `tests/corpus/fixtures/`.
Each fixture produces a "shape" snapshot:

```typescript
{
  ok: boolean,
  inputLines: number,
  outputLineRange: "10-24" | "25-49" | ...,   // bucketed
  translatedNodes: number,
  errorCount: number,
  warnCount: number,
  manualPortCount: number,
  diagnosticCodes: string[],     // sorted, unique
}
```

The output lines are **bucketed** (`<10`, `10-24`, `25-49`, `50-99`,
`100-199`, `200+`) so cosmetic edits to provenance comments don't
churn the snapshot. The diagnostic codes are a set, so adding a new
INFO diagnostic without changing categories doesn't break.

Run: `pnpm vitest run tests/corpus.test.ts`

### Updating snapshots after intentional changes

```bash
pnpm vitest run --update tests/corpus.test.ts
```

Do this **only** after verifying the new behavior is correct by reading
the diff. The snapshot file is `tests/__snapshots__/corpus.test.ts.snap`
— it's plain text, readable, and should be reviewed before committing.

### Round-trip subset (also in corpus.test.ts)

Six tests verify that for each AB fixture, `translate(input, "ab2mel")`
followed by `translate(<that output>, "mel2ab")` does NOT fail at the
parser stage and produces non-zero translated nodes.

This catches the class of bug where the emitter produces output that
its own parser can't read (the original C-style `/* TODO */` placeholder
bug). Critical for self-consistency.

---

## Layer 3: standalone harnesses (`tests/corpus/`)

Run outside vitest for fast iteration during compiler development.

### `tests/corpus/run.ts`

Executes every fixture through `translate()` and prints a colorized
summary. Use during compiler development to see immediate impact of
changes.

```bash
pnpm tsx tests/corpus/run.ts                 # all fixtures, both directions
pnpm tsx tests/corpus/run.ts tank             # filter to fixtures matching "tank"
pnpm tsx tests/corpus/run.ts -v 05_HMI        # verbose: dump full output
pnpm tsx tests/corpus/run.ts --direction=mel2ab   # one direction only
```

Output format:

```
  STATUS  filename.st  N→M ln · X nodes  (Ye Z mp W w)
          first issue, if any
```

- `STATUS` ∈ {`OK`, `WARN`, `MANL`, `ERR`, `EMPTY`, `PARSE`}
- `N→M ln` is input→output line counts
- `X nodes` is translated AST node count
- Counts: `e` errors, `mp` manual ports, `w` warnings, `i` infos

Exits non-zero if any fixture fails to translate. Suitable for CI gating.

### `tests/corpus/roundtrip.ts`

Runs each AB fixture forward (`ab2mel`), then runs the output
backward (`mel2ab`), then compares identifier sets.

```bash
pnpm tsx tests/corpus/roundtrip.ts
```

Tracks "meaningful identifier survival" — every non-keyword non-numeric
token from the original source that should appear in the round-trip
output. Some losses are expected and filtered (e.g., `TONR` → `TON`
because we lose retentive-ness; PID-instance members because PID is
untranslatable). Unexpected losses fail.

Output:
```
  PASS  fixture.st  N → M idents, X% survival
        new (ok): TODO_..._enable, ...     ← expected additions
        lost: ...                            ← unexpected losses (FAIL only)
```

---

## Adding a new fixture

1. Drop the `.st` file in `tests/corpus/fixtures/` (for AB ST) or
   `tests/corpus/fixtures/mel/` (for MEL ST).

2. Run the harness to see baseline behavior:
   ```bash
   pnpm tsx tests/corpus/run.ts <filename>
   ```

3. If the output looks correct, run vitest to generate the snapshot:
   ```bash
   pnpm vitest run tests/corpus.test.ts
   ```
   The new test will be added automatically (the suite enumerates
   `fixtures/`); the snapshot will be written.

4. Commit the fixture + the updated `corpus.test.ts.snap` file.

5. Verify round-trip:
   ```bash
   pnpm tsx tests/corpus/roundtrip.ts
   ```

---

## Adding a new instruction mapping

1. Open `server/compiler/emitter.ts` and add an entry to
   `INSTRUCTION_REWRITES`:
   ```typescript
   MY_AB_INSTR: (args, e) => `MY_MEL_FN(${e(args[0])}, ${e(args[1])})`,
   ```

2. Open `server/compiler/emitter-ab.ts` and add the reverse mapping if
   the MEL form is callable from MEL ST and an engineer might write it.

3. Add a unit test in `tests/translate.test.ts` if the behavior is
   subtle.

4. Add a fixture under `tests/corpus/fixtures/` that exercises the new
   instruction in realistic context.

5. Update `docs/INSTRUCTION_MAPPING.md` with the new row.

6. Run the full test suite. If snapshots need updating, do it.

---

## Diagnostic codes

All diagnostic codes follow the pattern `<SRC>_<DST>_<CATEGORY>_<NN>`:

| Pattern              | Meaning                            |
|----------------------|------------------------------------|
| `AB_MEL_PARSE_*`     | Parser errors during ab2mel        |
| `AB_MEL_PID_*`       | PID / PIDE manual-port             |
| `AB_MEL_MSG_*`       | MSG / messaging manual-port        |
| `AB_MEL_MOTION_*`    | Motion instruction manual-port     |
| `AB_MEL_TIMER_*`     | Timer translation notes            |
| `AB_MEL_COUNTER_*`   | Counter translation notes          |
| `AB_MEL_FLOW_*`      | Flow control (JSR/LBL/JMP/etc)     |
| `AB_MEL_PIPELINE_*`  | Pipeline-level (empty output, etc) |
| `AB_MEL_EMIT_ERR`    | Generic emit error                 |
| `MEL_AB_PARSE_*`     | Parser errors during mel2ab        |
| `MEL_AB_BIT_*`       | Bit-device manual-port             |
| `MEL_AB_PULSE_*`     | Pulse-edge manual-port             |
| `MEL_AB_FLOW_*`      | MEL-side flow control              |
| `MEL_AB_FB_*`        | FB invocation notes                |
| `MEL_AB_PIPELINE_*`  | Pipeline-level                     |

When adding a new code, follow this naming convention. Codes are
stable — once shipped, don't rename, only deprecate and add new.

---

## What to do when CI fails

Read this section before reaching for `--update`.

**Snapshot mismatch:**

```
- "translatedNodes": 28
+ "translatedNodes": 29
```

Investigate: what change added a translated node? Is it correct? Look
at the actual emitter output via `pnpm tsx tests/corpus/run.ts -v
<fixture>` to see what's different. If the new behavior is correct,
update the snapshot. If it's a regression, fix the emitter.

**Round-trip failure (parse stage):**

```
ERROR @N AB_MEL_PARSE_001: ...
```

This means emitMEL produced output emitAB's parser can't read. The
output is invalid IEC ST. Look at the line referenced and check the
emitter for the responsible code path. Common culprits:

  - C-style `/* */` comments (use `(* *)` instead)
  - Block comments embedded inside expressions
  - Identifier names with reserved punctuation
  - Missing semicolons

**Type-check failure:**

Almost always a missing import or signature mismatch from a file
merge. Run `pnpm tsc --noEmit` and follow the errors.

**Vitest unit test failure:**

The basic behavioral contract changed. If intentional, update the
test. If not, fix the regression. These 20 tests are the most
fundamental net — they cover behavior the UI depends on.
