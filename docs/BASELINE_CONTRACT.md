# Baseline Contract — Protected Proof-of-Concept Behavior

Status: **frozen at `aef95f9`** (Phase 1 + Phase 2 baseline).
Purpose: this document records the behavior the long-term build-out must preserve.
Any change that alters an item here requires an explicit, tested, documented decision
in `docs/BUILDOUT_STATUS.md`. This is a *protection* contract, not an aspiration.

## 1. Public entry point (legacy contract)

```ts
translate(source: string, direction: "ab2mel" | "mel2ab", options?: { memoryMap?: string; labelsCsv?: string }): TranslationResult
```

- `direction: "ab2mel"` — Allen-Bradley Structured Text (and L5K exports) → Mitsubishi (MEL) ST.
- `direction: "mel2ab"` — Mitsubishi ST → Allen-Bradley ST.
- Returns `TranslationResult` (see `server/translate.ts`) with fields:
  `ok, output, diagnostics, mappingYaml, labelsCsv, fbDefinitions, udtDefinitions,
  failureReport, stats{inputLines,outputLines,warningCount,manualPortCount,translatedNodes}`.
- Consumed by `server/routers.ts` (`translate` tRPC mutation) and the Expo client
  (`app/(tabs)/index.tsx`, `app/output.tsx`, `app/(tabs)/history.tsx`).

**Migration rule:** this signature and return shape must keep working through a
compatibility adapter until the API/UI are explicitly migrated (Phase 11). No commit
may break existing callers of `translate(...)`.

## 2. Protected components (inherited assets)

| Component | File(s) | Protected behavior |
|---|---|---|
| ST tokenizer + recursive-descent parser | `server/compiler/parser.ts` | IEC 61131-3 ST → AST; 26 node kinds (see §3) |
| AB→MEL emitter | `server/compiler/emitter.ts` | instruction rewrites, memory allocation, mapping/labels |
| MEL→AB emitter | `server/compiler/emitter-ab.ts` | reverse emission, pulse/bit handling |
| L5K detect + extract | `server/compiler/l5k_extract.ts` | controller/IE_VER, ST & ladder routines, tags, UDTs, modules, AOIs |
| Ladder parser | `server/compiler/ladder_parser.ts` | rung mnemonic tokenizer + AST; instruction roles; `UNSUPPORTED_BUILTINS` |
| Ladder→ST emitter | `server/compiler/ladder_emitter.ts` | rung → ST, OTE combinational, self-gated timer/counter outside IF wrapper |
| AOI → FUNCTION_BLOCK | `server/compiler/aoi_emitter.ts` | AOIs to IEC FB declarations |
| Labels CSV | `server/compiler/labels_emitter.ts` | GX Works global-label CSV + UDT summary |
| Module / IO map | `server/compiler/module_emitter.ts` | chassis + modules YAML with `mel_target_address` TODO |
| Diagnostics + failure report | `server/translate.ts` | structured `Diagnostic[]` + `FailureReport` |

These files are **protected assets**. The build-out wraps and re-routes them; it does not
delete emitter logic until parity tests prove a replacement path (Phase 5 rule).

## 3. Parser AST node kinds (must remain recognized)

`assign, binary_op, bit_access, block, call, case, comment, compare, exit, fb_invoke,
for, function_call, ident, if, index, literal, logical, member_access, program, repeat,
return, type_cast, unary_op, var_block, var_decl, while`

## 4. Behavioral fixtures (must stay translatable)

Corpus (`pnpm tsx tests/corpus/run.ts`) — **7/7 translated, 0 failed/empty**:

| Fixture | Direction | Baseline result |
|---|---|---|
| 01_ARRAY100_AVERAGE.st | AB→MEL | OK, 10 nodes |
| 02_ARRAY2000_AVERAGE.st | AB→MEL | OK, 10 nodes |
| 03_CHECK_SUM.st | AB→MEL | OK, 11 nodes |
| 04_FEN20_DATA_MOVE.st | AB→MEL | WARN (TONR reset path), 83 nodes |
| 05_HMI_ALARM_MESSAGE.st | AB→MEL | OK, 36 nodes |
| tank_level_pid_loop.st | AB→MEL | MANUAL (10 manual-port, PID) |
| mel/runtime_basics.st | MEL→AB | MANUAL (2 manual-port, FB invoke) |

Round-trip (`pnpm tsx tests/corpus/roundtrip.ts`) — **6/6 passed** (AB→MEL→AB identifier survival ≥ 84%).

Unit tests (`pnpm test`) — **33 passed, 1 skipped** (`tests/translate.test.ts`, `tests/corpus.test.ts`; `auth.logout` skipped).

## 5. Semantic-honesty invariants (never regress)

- Unsupported/manual-port instructions surface as `MANUAL_PORT` diagnostics and/or
  `(* MANUAL_PORT: ... *)` scaffolds — never silent pass-through as valid target code.
- PID, motion, MSG, and Rockwell-specific instructions are reported, not approximated.
- Timer PT presets emit `T#0ms` placeholder + TODO (documented limitation), not a guess.
- OTE emits `Y := <cond>;` (combinational), not `Y := TRUE;`.
- Provenance comments (`// [AB→MEL] ...`, `(* ── Rung N ── *)`) are preserved.

## 6. Diagnostic code namespaces in the baseline

`AB_MEL_*` (PARSE_001, FLOW_00x, TIMER_00x, COUNTER_001, PID_00x, MOTION_001, MSG_001,
PIPELINE_00x, LADDER_WARN, EMIT_ERR, L5K_00x), `MEL_AB_*` (BIT_00x, FB_001, FLOW_00x,
PULSE_0x, PIPELINE_00x). New namespaces (`PARSE_*, SEMANTIC_*, TYPE_*, IR_*, CAPABILITY_*,
LOWERING_*, EMIT_*, PROJECT_*, ROCKWELL_*, MITSUBISHI_*, SIEMENS_*, AEON_*`) are added by the
build-out; legacy codes remain emitted through the compatibility path until Phase 11.

## 7. Green baseline commands (Phase 0 gate)

```
pnpm install --frozen-lockfile
pnpm check                          # tsc --noEmit → exit 0
pnpm test                           # 33 passed, 1 skipped
pnpm tsx tests/corpus/run.ts        # 7/7 translated
pnpm tsx tests/corpus/roundtrip.ts  # 6/6 passed
pnpm build                          # esbuild → dist/index.js
```

All six are green at `aef95f9`. The build-out may not weaken any of them to manufacture green.
