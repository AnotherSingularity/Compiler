# HANDOFF — compiler-v1 deployment

This document is for Manus. It describes exactly what to do with the
tarball, what to verify, and what success looks like.

---

## What's in the tarball

`horizon-compiler-v1.tar.gz` is the full repo with:

  - All prior UI work (horizon-v3 state) preserved
  - New compiler core in `server/compiler/`
  - New test infrastructure in `tests/`
  - This `docs/` directory

`node_modules`, `.expo`, and `dist` are stripped — install fresh.

---

## Install

```bash
tar -xzf horizon-compiler-v1.tar.gz
cd ab-mel-st-compiler
pnpm install        # or npm install
```

Node version: 20+ recommended. The build uses Expo SDK 54, RN 0.81.5,
TypeScript 5.9, vitest 2.1.9.

---

## Acceptance criteria

Run these four commands. All four must pass cleanly for the redeploy
to be considered successful.

### 1. Type check

```bash
pnpm tsc --noEmit
```

Expected: exit 0, no output.

### 2. Unit + corpus tests

```bash
pnpm vitest run
```

Expected:
```
 Test Files  2 passed | 1 skipped (3)
      Tests  33 passed | 1 skipped (34)
```

The skipped test is `auth.logout.test.ts` (pre-existing, unrelated to
compiler work).

### 3. Corpus harness (both directions)

```bash
pnpm tsx tests/corpus/run.ts
```

Expected output:
```
── AB → MEL ──
  OK     01_ARRAY100_AVERAGE.st  19→24 ln · 10 nodes
  OK     02_ARRAY2000_AVERAGE.st  19→24 ln · 10 nodes
  OK     03_CHECK_SUM.st         26→25 ln · 11 nodes
  WARN   04_FEN20_DATA_MOVE.st  136→187 ln · 83 nodes  1w
  OK     05_HMI_ALARM_MESSAGE.st 46→74 ln · 36 nodes
  MANL   tank_level_pid_loop.st 127→165 ln · 28 nodes  10mp
── MEL → AB ──
  MANL   runtime_basics.st       47→70 ln · 20 nodes  2mp

summary  7/7 translated, 0 failed/empty
```

The `WARN` and `MANL` badges are correct outcomes (retentive timer
caveats; PID is genuinely untranslatable). The line counts and node
counts are pinned by the snapshot suite.

### 4. Round-trip preservation

```bash
pnpm tsx tests/corpus/roundtrip.ts
```

Expected:
```
  PASS  01_ARRAY100_AVERAGE.st  6 → 6 idents, 100% survival
  PASS  02_ARRAY2000_AVERAGE.st  6 → 6 idents, 100% survival
  PASS  03_CHECK_SUM.st         11 → 11 idents, 100% survival
  PASS  04_FEN20_DATA_MOVE.st   70 → 71 idents, 99% survival
  PASS  05_HMI_ALARM_MESSAGE.st  6 → 6 idents, 100% survival
  PASS  tank_level_pid_loop.st  24 → 22 idents, 84% survival

round-trip summary  6/6 passed
```

The "new (ok)" tokens in the output are expected additions (placeholder
identifiers, RES instructions). The "lost" tokens in the tank fixture
are PID-related and documented as untranslatable.

---

## If anything fails

### tsc errors

Almost certainly an import or signature mismatch from the file merge.
The compiler stack only depends on:

  - `server/compiler/parser.ts` exports types + `parseSTSource`
  - `server/compiler/emitter.ts` exports `emitMEL`
  - `server/compiler/emitter-ab.ts` exports `emitAB`
  - `server/translate.ts` imports all three and `Diagnostic` type

If `tsc` complains about a missing module, verify all four files copied
in correctly.

### vitest snapshot mismatch

If a snapshot fails on the first run after redeploy, that means the
emitter output differs from what was pinned. This is a regression — do
not blindly run `vitest run --update`. Compare the diff first.

Likely causes if snapshots fail:

  - Different Node version producing different number formatting
  - Wrong file copied (verify `wc -l` against the table in `CHANGELOG.md`)
  - A merge conflict ate part of the emitter

If snapshots fail and the cause is investigated and the change is
intentional, accept with: `pnpm vitest run --update tests/corpus.test.ts`

### Corpus harness fails

If `tests/corpus/run.ts` reports `PARSE` or `EMPTY`, the parser is
choking on a fixture. Read the failure report — `extractErrorLine` in
`server/translate.ts` gives line numbers and source context.

---

## Directory layout (reference)

```
ab-mel-st-compiler/
├── app/                          (UI — Expo Router)
│   ├── (tabs)/
│   │   ├── home.tsx
│   │   ├── history.tsx
│   │   └── index.tsx             (translate screen)
│   └── output.tsx
├── components/
│   └── output-panel.tsx          (shared output surface)
├── server/
│   ├── compiler/
│   │   ├── parser.ts             ← edited
│   │   ├── emitter.ts            ← rewritten
│   │   └── emitter-ab.ts         ← new
│   ├── translate.ts              ← edited (wired emitAB)
│   └── routers.ts                (tRPC — untouched)
├── tests/
│   ├── translate.test.ts         (original 20 unit tests, unchanged)
│   ├── corpus.test.ts            ← new (vitest snapshot suite)
│   ├── corpus/
│   │   ├── run.ts                ← new (iteration harness)
│   │   ├── roundtrip.ts          ← new (round-trip harness)
│   │   └── fixtures/
│   │       ├── 01_ARRAY100_AVERAGE.st
│   │       ├── 02_ARRAY2000_AVERAGE.st
│   │       ├── 03_CHECK_SUM.st
│   │       ├── 04_FEN20_DATA_MOVE.st
│   │       ├── 05_HMI_ALARM_MESSAGE.st
│   │       ├── tank_level_pid_loop.st
│   │       └── mel/
│   │           └── runtime_basics.st
│   └── __snapshots__/
│       └── corpus.test.ts.snap   ← new (7 pinned snapshots)
└── docs/
    ├── CHANGELOG.md
    ├── HANDOFF.md                ← you are here
    ├── ARCHITECTURE.md
    ├── INSTRUCTION_MAPPING.md
    ├── TESTING.md
    └── KNOWN_LIMITATIONS.md
```

---

## Running the dev server

After redeploy, the dev server still launches the way it did before:

```bash
pnpm start          # Expo dev server
pnpm dev:web        # Web target
pnpm dev:android    # Android (requires emulator or device)
pnpm dev:ios        # iOS (macOS only)
```

The compiler runs server-side via tRPC. The translate route lives in
`server/routers.ts` — no changes needed there; it pulls from
`server/translate.ts` which now correctly routes both directions.

---

## What to tell the user

After redeploy, the translation page works in both directions for the
first time. AB → MEL works for general ST routines (FOR loops, arrays,
bit-of-word, type conversions, timers, counters). MEL → AB works for
the same patterns in reverse. PID, motion, and messaging instructions
emit clearly-marked manual-port comments with parameter lists.

There are no breaking UI changes. History entries from before the
redeploy will continue to display correctly.

---

## Contact / next steps

The compiler is at v1 — usable on real corpus, regression-protected,
documented. The list in `docs/KNOWN_LIMITATIONS.md` shows where work
continues. Adding any new instruction mapping is a 2-line change in
`INSTRUCTION_REWRITES` + a snapshot update.
