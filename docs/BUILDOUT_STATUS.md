# Build-Out Status Ledger

Append-only ledger for the PLC compiler platform build-out (AB/Mitsubishi PoC →
vendor-neutral, IR-centered compiler). Newest entries at the bottom of each phase.
See `docs/BASELINE_CONTRACT.md` for the frozen protected behavior.

Conventions:
- Every phase/subphase records: commit, files, architectural result, commands, tests, limitations, next.
- Never squash/rewrite/force-push shared history. Small additive commits.
- A phase is not "complete" until its gate commands are green and pushed.

---

## Phase 0 — Mechanical Baseline and Freeze

**Status:** COMPLETE

**Working branch:** `claude/happy-johnson-dy7zxl` (restarted from `origin/main` = `aef95f9`,
which is the Phase 1+2 baseline; the branch previously held only already-merged Phase 1
history `b52a8fe`, an ancestor of `aef95f9`, so this is a fast-forward, not a rewrite).

**Baseline commit inspected:** `aef95f9` — "Phase 2 L5K artifacts".

**Environment:** Node v22.22.2, pnpm 9.12.0. No active merge/rebase/cherry-pick. Lockfile unchanged.

### Baseline gate results (at `aef95f9`, before any Phase 0 change)

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | OK, lockfile unchanged |
| `pnpm check` (`tsc --noEmit`) | exit 0 |
| `pnpm test` | 33 passed, 1 skipped (2 files + 1 skipped file) |
| `pnpm tsx tests/corpus/run.ts` | 7/7 translated, 0 failed/empty |
| `pnpm tsx tests/corpus/roundtrip.ts` | 6/6 passed |
| `pnpm build` | esbuild → dist/index.js 154.5kb, exit 0 |

Baseline is **green**. No repository defect found → no Phase 0 corrective commit needed.

### Inventory captured

- **Parser node kinds (26):** assign, binary_op, bit_access, block, call, case, comment,
  compare, exit, fb_invoke, for, function_call, ident, if, index, literal, logical,
  member_access, program, repeat, return, type_cast, unary_op, var_block, var_decl, while.
- **Emitters:** `emitter.ts` (AB→MEL, 549 ln), `emitter-ab.ts` (MEL→AB, 440 ln).
- **L5K/ladder/AOI/tag/module paths:** `l5k_extract.ts` (799), `ladder_parser.ts` (445),
  `ladder_emitter.ts` (543), `aoi_emitter.ts` (171), `labels_emitter.ts` (159),
  `module_emitter.ts` (111).
- **Legacy `ab2mel`/`mel2ab` dependents (3 files, 18 refs):** `server/translate.ts`,
  `app/(tabs)/index.tsx`, `app/(tabs)/history.tsx`. (`server/routers.ts` passes `input.direction`
  through to `translate` and persists it to the DB.)
- **Diagnostic namespaces today:** `AB_MEL_*`, `MEL_AB_*` (see BASELINE_CONTRACT §6).
- **Manual-port / unsupported paths:** emitter MANUAL_PORT markers (17 sites) +
  `ladder_parser.UNSUPPORTED_BUILTINS` set + `instructionRole()` classification.

### Deliverables (this phase)

- `docs/BASELINE_CONTRACT.md` — protected behavior (new).
- `docs/BUILDOUT_STATUS.md` — this ledger (new).
- `.github/workflows/ci.yml` — CI: install(frozen) → check → test → test:corpus →
  test:roundtrip → build, on push + PR (new).
- `package.json` — added `test:corpus`, `test:roundtrip` script aliases (additive; no
  existing script removed; lockfile untouched).

**Commands executed:** see gate table above; both new aliases verified (`test:corpus OK`,
`test:roundtrip OK`).

**Known limitations:** CI workflow authored but its first run must be confirmed green on the
remote (recorded on push). No functional/compiler behavior changed in Phase 0.

**Next phase:** Phase 1 — Public compiler contracts + legacy compatibility adapter
(`server/compiler/contracts/`, `CompileRequest`/`CompileResult`, `LanguageId`, adapter that
maps `translate(src, "ab2mel"|"mel2ab")` onto a `CompileRequest`). No behavior change.

---

## Phase 0.1 — Corrective: ESM `require()` → static imports

**Status:** COMPLETE · **Commit:** `0582f7e`

**Files:** `server/compiler/ladder_emitter.ts`, `server/translate.ts`.

**Result:** The L5K ladder path used CommonJS `require()` inside functions, which
throws under ESM. The production server bundles with esbuild `--format=esm`, so this
was a latent production crash on any L5K input (only masked because tests/harnesses ran
via tsx and no vitest test exercised the L5K path). Replaced with static imports; both
modules are acyclic with their targets so the change is behavior-preserving.

**Commands/tests:** `pnpm check` 0 · `pnpm test` 33→still green · corpus 7/7 · roundtrip 6/6
· build OK. (This corrective was verified together with Phase 1 below.)

**Known limitations:** none introduced. **Next:** Phase 1.

---

## Phase 1 — Public Compiler Contracts

**Status:** COMPLETE · **Commit:** `6ab0c72` · **CI:** run 30470630294 = success

**Files (new):** `server/compiler/version.ts`, `server/compiler/contracts/{ids,source,
diagnostics,compile,hash,index}.ts`, `server/compiler/compat/legacy-adapter.ts`,
`tests/compiler/contracts.test.ts`. Ledger updated.

**Architectural result:**
- Language-neutral contracts introduced (invariants A/C/D/E/F/G): `LanguageId` (7 ids),
  `ArtifactKind` (5), `TranslationDisposition` (6), `CompilerStage`, `CompletenessLevel`,
  `SourceArtifact`/`SourceSpan` (provenance), `CompilerDiagnostic` (deterministic ordering),
  `CompileRequest`/`CompileResult`/`CompileOptions`, `GeneratedArtifact`,
  `SemanticLossRecord`, `CompileStats`, `CompileHashes`. No vendor syntax in contracts.
- `version.ts`: `COMPILER_VERSION=0.1.0`, `IR_SCHEMA_VERSION=1.0.0`.
- `hash.ts`: `canonicalJson` (recursive key sort) + `sha256Hex` → deterministic hashes.
- Compatibility adapter `compile(request)` / `compileLegacy(source, direction)` delegates to
  the **unchanged** `translate()` for the two legacy routes; validates requests; **fails
  closed** on unknown languages and unsupported combinations (structured
  `CAPABILITY_UNSUPPORTED_COMBINATION`, `ok:false`, no artifacts). Only the adapter holds
  `ab2mel`/`mel2ab` hardcoding, by design.
- `CompileResult.ok` is kept behaviorally equivalent to legacy `ok`; the new
  `completeness` level carries the finer honesty signal (tightened in Phase 6).

**Commands/tests:** `pnpm check` exit 0 · `pnpm test` **53 passed, 1 skipped** (20 new
Phase-1 tests) · `pnpm test:corpus` 7/7 · `pnpm test:roundtrip` 6/6 · `pnpm build` OK.
Phase-1 tests cover: legacy adapter equivalence (output/stats/diag parity), request
validation, unknown-language rejection, unsupported-combination fail-closed, determinism
(identical hashes, canonical JSON, diagnostic ordering), artifact & diagnostic schema.

**Known limitations:**
- Adapter still routes through the legacy `translate()` (no registry yet — Phase 2) and does
  not yet produce canonical IR (Phase 3) or real semantic-loss records (Phase 6;
  `semanticLosses` is `[]`).
- Source-language auto-detection is legacy-mirroring only (L5K vs Logix ST); true
  multi-language detection is Phase 2.
- `CompileResult.ok` not yet tightened to fail on manual-port/unsupported (Phase 6).
- Legacy line-only diagnostics lift to `lineSpan` with `offset:-1` (no byte offset yet).

**Phase 1 gate:** MET — existing outputs remain behaviorally equivalent through the adapter
(asserted by equivalence tests).

**Next phase:** Phase 2 — Language registry + plugin interfaces (`LanguageFrontend`/
`LanguageBackend`, deterministic registry, detection with confidence/evidence, register
Rockwell Logix ST / Rockwell L5K / Mitsubishi GX ST; move the orchestrator off the direct
`ab2mel`/`mel2ab` if/else so legacy directions live only in the adapter).

---

## Phase 2 — Language Registry and Plugin Interfaces

**Status:** COMPLETE · **Commit:** `c22680b` · **CI:** run 30471375064 (push, ci.yml)

**Files (new):** `server/compiler/contracts/{operations,capability,ir,plugin}.ts`,
`server/compiler/registry/{registry,orchestrator,default-registry,index}.ts`,
`server/compiler/languages/{rockwell,mitsubishi}.ts`,
`server/compiler/compat/legacy-bridge.ts`, `tests/compiler/registry.test.ts`.
**Files (changed):** `server/compiler/contracts/index.ts` (re-exports),
`server/compiler/compat/legacy-adapter.ts` (now routes through the registry), ledger.

**Architectural result:**
- Canonical semantic vocabulary (invariant C): `SemanticOperationKind` (28, incl.
  TimerOnDelay/TimerRetentive/CounterUp/BlockCopy/MaskedMove/PIDControl/MotionCommand/
  VendorExtension/UnsupportedOperation), `CanonicalTypeKind` (14), `ProjectFeatureKind` (8).
  Vendor mnemonics never appear as canonical identities.
- Plugin contracts: `LanguageFrontend` (detect→confidence+evidence, parse→ParseResult),
  `LanguageBackend` (capabilities/lower/emit), `CapabilityManifest`/`CapabilityRule`,
  `DetectionResult`, and a transitional `SourceEmitCapable` used during the IR migration.
- `LanguageRegistry`: explicit registration (no hidden global side effects), deterministic
  id-sorted listing/inventory, **duplicate registration fails deterministically**
  (`RegistryError`), detection aggregates candidates and **fails closed on ambiguity**
  (margin 0.15) and on no-match.
- Built-in plugins registered: Rockwell Logix ST (frontend+backend), Rockwell L5K
  (frontend; project bodies delegate to Logix ST — invariant A), Mitsubishi GX ST
  (frontend+backend). Backends expose machine-readable capability manifests (PID→manual_port,
  Motion→unsupported, TimerOnDelay→lossy, etc.).
- **Central orchestrator (`compileWithRegistry`) has no `ab2mel`/`mel2ab`** — it detects/
  resolves the source, looks up the target backend, checks the emit surface, and fails
  closed otherwise. Legacy direction strings now live ONLY in `compat/legacy-bridge.ts`
  and the `directionToLanguages` map in the adapter (compat layer).
- `legacy-adapter.compile()` rewired to build an explicit request and delegate to the
  orchestrator → still byte-equivalent to `translate()` for the two PoC routes.

**Commands/tests:** `pnpm check` 0 · `pnpm test` **71 passed, 1 skipped** (18 new Phase-2
tests) · `pnpm test:corpus` 7/7 · `pnpm test:roundtrip` 6/6 · `pnpm build` OK. Phase-2 tests
cover: registry ordering/duplicate-failure/inventory determinism; detection confidence+
evidence, ambiguity fail-closed, no-match; orchestrator routing + legacy equivalence +
fail-closed on ambiguous/no-backend; capability manifest inspection; frontend parse.

**Known limitations:**
- Emission still flows through the legacy bridge (`translate()`), not canonical IR. The
  backends' `lower()`/`emit()` return `LOWERING_/EMIT_IR_PATH_PENDING` info diagnostics
  until Phase 5 wires the IR path. `CanonicalProgram`/`LoweredProgram` are Phase-2 stubs
  (Phase 3 fleshes them out); frontend `parse()` carries the legacy AST in `program.raw`.
- Detection between dialect-neutral Rockwell vs Mitsubishi ST is intentionally ambiguous
  (correct fail-closed); the legacy adapter still resolves it via the L5K signature +
  direction pairing (legacy-mirroring), not the registry detector.
- `semanticLosses` still `[]` (Phase 6). `CompileResult.ok` not yet tightened (Phase 6).

**Phase 2 gate:** MET — orchestrator no longer contains an `ab2mel`/`mel2ab` if/else;
legacy directions live only in the compat bridge/adapter.

**Next phase:** Phase 3 — Canonical PLC IR v1 (`server/compiler/ir/`): real node model
(program structure, types, expressions, statements) separate from the syntax AST,
deterministic JSON (de)serialization + schema validation, stable hashes, source-span
preservation, `irSchemaVersion` 1.0.0. First files: `server/compiler/ir/nodes.ts`,
`server/compiler/ir/serialize.ts`, `server/compiler/ir/validate.ts`, and
`tests/compiler/ir.test.ts`.

---

## Stage 0 (continuation) — Reverify handoff

**Status:** COMPLETE. Branch `claude/happy-johnson-dy7zxl`, local==remote==`fd129af`, clean,
no in-progress git op. Phase 2 CI run `30471375064` (head `c22680b`) = **success**. Baseline
gate reverified green at `fd129af`: `pnpm install --frozen-lockfile` (lockfile unchanged),
`pnpm check` 0, `pnpm test` 71 passed/1 skipped, `pnpm test:corpus` 7/7, `pnpm test:roundtrip`
6/6, `pnpm build` OK.

---

## Stage 1 — Canonical PLC IR v1

**Status:** COMPLETE · **Commit:** `deca4f0`

**Files (new):** `server/compiler/ir/{version,nodes,types,expressions,operations,statements,
declarations,project,hash,serialize,validate,upgrade,guards,normalize,index}.ts`;
`tests/compiler/ir/{ir,corpus-normalization}.test.ts`. **Changed:** `package.json`
(`test:ir` script), this ledger.

**Architectural result:**
- Real canonical semantic program model **separate from the syntax AST** (the parser AST is
  NOT renamed). Nodes: program/resource/task/io_point; routine/function/function_block;
  var_decl/type_decl; 15 expression kinds; 15 statement kinds; `semantic_operation` with a
  canonical `SemanticOperationKind` (snake_case, 25 kinds) — vendor mnemonics (TON/RTO/CTU/
  COP/CPS/BMOV/MVM/RES/LIM…) live only in provenance/`vendorAnnotations`.
- 14 canonical types (bool/int{signed,bits}/real{bits}/string{capacity}/time/date/datetime/
  array{explicit bounds,inferred flag}/structure/enumeration/alias/fb_instance/hardware_ref/
  opaque_vendor/unresolved).
- **Deterministic structural node ids** (`nodeIdFromPath` = sha256 of a source-structural
  path → `ir_<12hex>`): stable across recompiles, insertion-order changes, and hash seed;
  no random UUIDs.
- Provenance on every node: `SourceOrigin` (sourceId/language/artifactKind/span/nodeKind/
  mnemonic) or `SyntheticOrigin` (generatedBy/derivedFrom/reason) — synthetic nodes never
  get a fake source span.
- **Deterministic serialization** (`canonicalJson` key-sorted) + envelope
  (`schema:"plc-canonical-ir"`, `schemaVersion` 1.0.0, compilerVersion, program, hashes);
  `assertPlainData` rejects functions/class-instances/cycles; two hashes — `serialized`
  (incl. provenance) and `semantic` (provenance-stripped).
- **Validation** → `IR_*` diagnostics: unknown node kind, duplicate id, broken reference
  (synthetic derivedFrom), invalid span, missing origin, missing expression type, invalid
  array bounds, vendor-mnemonic-as-identity, unknown operation, schema tag/version.
- **Upgrade registry**: passes v1 through; rejects future/unknown versions and missing
  upgrade paths (never silently reinterprets).
- **Normalizer** `normalizeStProgram/normalizeStRoutineAst`: maps the parser AST subset →
  IR with structural ids + real spans; unresolved types stay `unresolved` (no fabricated
  types — Stage 2 resolves them).

**Commands/tests:** `pnpm check` 0 · `pnpm test:ir` **45 passed** (2 files) · `pnpm test`
**116 passed, 1 skipped** · `pnpm test:corpus` 7/7 · `pnpm test:roundtrip` 6/6 · `pnpm build`
OK. IR tests cover schema/envelope round-trip, serialization determinism + byte-stability,
plain-data rejection, stable node ids, validation (all IR_* codes above), upgrade
accept/reject, provenance, and **corpus normalization** of all 7 ST fixtures (validate-clean,
deterministic hash/ids, envelope round-trip, no vendor mnemonic as identity).

**Known limitations / honesty:**
- The IR is **not yet the production path** — production still routes through the registry →
  legacy bridge → `translate()` (Stage 3 wires the IR through lowering + emission). The
  normalizer covers the ST expression/statement subset; declarations map primitives only
  (arrays/UDT type-string parsing is Stage 2), and semantic operations (timers/counters/
  copy) are NOT yet produced by the normalizer — that is Stage 2 operation-normalization.
- No symbol/type resolution yet (all non-literal expression types are `unresolved`) — Stage 2.

**Stage 1 gate:** MET — canonical IR is real, serializable, validated, hashed, and exercised
by corpus-derived tests.

**Next:** Stage 2 — semantic-analysis pipeline (`server/compiler/semantic/`): scopes, symbols,
type resolution, conversion classification, **parser recovery correction** (remove the
literal-fabrication fallback), and operation normalization (TON→timer_on_delay, COP→block_copy,
etc.) feeding the IR. Then Stage 3 migrates Rockwell/Mitsubishi production through the IR.

---

## Stage 2 (part A) — Operation normalization

**Status:** COMPLETE (partial stage) · **Commit:** `c896c84`

**Files (new):** `server/compiler/semantic/{operation-normalization,index}.ts`,
`tests/compiler/semantic/operations.test.ts`. **Changed:** `package.json` (`test:semantic`),
ledger.

**Architectural result:** `normalizeProgramOperations(program)` — a pure, deterministic pass
that rewrites canonical `call` nodes whose name is a known vendor mnemonic into canonical
`semantic_operation` nodes (invariant C). Mapping: TON→timer_on_delay, TOF→timer_off_delay,
RTO/TONR→timer_retentive, CTU→counter_up, CTD→counter_down, COP/BMOV→block_copy,
CPS→synchronous_block_copy, MVM→masked_move, LIM/LIMIT→limit_test, MSG→message_transfer,
PID/PIDE→pid_control, JSR→routine_call. The mnemonic is preserved in `origin.sourceMnemonic`
+ `vendorAnnotations.mnemonic`; node ids and statement order are preserved (stable hashes for
unaffected structure); the input is not mutated. Recurses through nested control flow. A
default disposition hint is attached (Stage 4 capability enforcement is authoritative).
Conservative: RES is intentionally NOT mapped (its canonical identity — timer_reset vs
counter_reset — needs operand type resolution, which is later Stage 2 work; mapping it now
would be a guess).

**Commands/tests:** `pnpm check` 0 · `pnpm test:semantic` **8 passed** · `pnpm test` **124
passed, 1 skipped** · `pnpm test:ir` 45 · corpus 7/7 · roundtrip 6/6 · build OK.

**Known limitations / honesty:** This is one Stage-2 pass. The remaining Stage-2 work —
scopes/symbols, type resolution, conversion classification, control-flow checks, the full
`pipeline.ts`, and the **parser-recovery correction** (removing the literal-fabrication
fallback) — is NOT yet done. The operation-normalization pass is not yet wired into a
production compile path (Stage 3). Production emission still routes registry → legacy bridge
→ `translate()`.

**Next:** Stage 2 (part B) — scope/symbol/type resolution + conversion classification +
parser-recovery correction; then Stage 3 production migration through the IR.

---

## Stage 2 (part B, subset) — Parser recovery correction

**Status:** COMPLETE (partial stage) · **Commit:** `9911115`

**Reverified start:** local==remote==`c896c84`, clean. Prior CI: Stage 1 `deca4f0` run
30472975634 = success; Phase 2 `c22680b` run 30471375064 = success. Baseline gate green.

**Files (changed):** `server/compiler/parser.ts` (production parser). **New:**
`tests/compiler/semantic/parser-recovery.test.ts`.

**Architectural result (real production change):** The parser's `parseAtom` fallback no
longer fabricates an integer literal for unexpected tokens. It now records a structured
`PARSE_UNEXPECTED_TOKEN` diagnostic, consumes the token (guaranteed forward progress), and
returns an explicit `ErrorNode` carrying the offending text + source position. Added:
`ErrorNode`/`ParseDiagnostic` types, a `diagnostics` collection + `maxErrors` (500) recovery
cap on the `Parser`, and a new `parseSTSourceWithDiagnostics(source) → {ast, diagnostics,
partial}` entry point. `parseSTSource(source): ASTNode[]` is unchanged, so all existing
callers (translate/emit/normalize) are unaffected. This is in the **production parse path**
used by `translate()` — malformed input can no longer manufacture an executable value.

**Commands/tests:** `pnpm check` 0 · `pnpm test:semantic` **14 passed** (8 ops + 6 recovery)
· `pnpm test` **130 passed, 1 skipped** · corpus 7/7 · roundtrip 6/6 · build OK. Recovery
tests: no fabricated literal, error node + PARSE_ diagnostic emitted, span preserved, clean
source → 0 diagnostics/not partial, termination on repeated garbage (cap respected),
deterministic diagnostic ordering, AST-only entry point still clean.

**HONEST STATUS OF THE PRODUCTION-PATH FLIP (the primary ask of this order):**
- **NOT DONE.** Actual translation output is **still produced by the legacy engine**
  (`translate()` → `emitMEL`/`emitAB`) via the registry → bridge. The canonical
  IR + operation normalization + parser recovery are real and tested, but the
  canonical **lowering + emission** layer that would let the canonical path reproduce the
  legacy corpus output at parity does NOT exist yet, so the default path was not flipped.
- Flipping the default before a parity-capable canonical ST emitter exists would make
  corpus/round-trip/CI red (forbidden) or require rewriting corpus assertions to match new
  output (snapshot-gaming, forbidden). Neither was done. The legacy engine remains the
  production default, honestly.

**Next (load-bearing, remaining):** build `server/compiler/lowering/{rockwell,mitsubishi}`
consuming canonical IR and a canonical ST emitter that reaches corpus parity, add
`verify:legacy-parity` + `tests/compiler/migration/*`, THEN flip `compile()`/`translate()` to
the canonical path with legacy demoted to `translateLegacyForParity`. This is multi-commit
work; each operation family must reach parity before the default flips.

---

## Stage 3 (families 1–3) — Canonical production activation: expressions, assignments, control_flow

**Status:** COMPLETE for 3 families · **Commit:** `59b2257`

**Reverified start:** local==remote==`9911115`, clean; CI `deca4f0`/`c22680b` = success; baseline green.

**Files (new):** `server/compiler/migration/{families,routing,parity,fixtures,approvals,index}.ts`,
`server/compiler/lowering/st-emitter.ts`, `scripts/verify-legacy-parity.ts`,
`tests/compiler/migration/{production-routing,parity,no-legacy-import}.test.ts`.
**Changed:** `server/compiler/registry/orchestrator.ts` (canonical routing before legacy),
`server/compiler/contracts/compile.ts` (`migration` summary field), `package.json`
(`test:migration`, `verify:legacy-parity`), ledger.

**Architectural result — REAL production behavior change:**
- Incremental migration model: `MigrationFamily` (16), `MigrationStatus`
  (legacy_only/canonical_shadow/canonical_active/canonical_complete), version-controlled
  `DEFAULT_FAMILY_STATUS` (**expressions/assignments/control_flow = canonical_active**, rest
  legacy_only), inspectable `MigrationRegistry`.
- Canonical ST lowering/emitter (`lowering/st-emitter.ts`) — precedence-correct,
  minimally-parenthesized ST for expr/assign/control-flow; formats lowered IR nodes only;
  isolated (a test fails if it imports the legacy translator/parser/emitters/bridge).
- Orchestrator routing: `compile()` parses → normalizes to canonical IR → operation-
  normalizes → checks family coverage; **if fully covered by active families it emits via the
  canonical path** (`migration.engine === "canonical"`), else falls back to the legacy engine
  (`engine === "legacy"`). Coverage requires every statement in an active family AND every
  expression canonically emittable AND no unmigrated declarations. `CompileResult.migration`
  exposes the routing.
- Parity harness + `pnpm verify:legacy-parity`: compares canonical vs the legacy oracle for 16
  fixtures (8 snippets × 2 directions); **0 unapproved differences**. All 16 differ from legacy
  as `canonical_improvement` (legacy adds a `// [AB→MEL]` provenance comment + full
  parenthesization; canonical is clean) — each pinned to both output hashes in
  `approvals.ts`; the harness fails if a pinned hash drifts.

**Verified production path (now):** `compile()` / `compileLegacy()` →
`compileWithRegistry` → **canonical (expr/assign/control_flow) OR legacy (everything else)**.
A pure `y := a + b * 2 - 1;` compiles to `y := a + b * 2 - 1;` via the canonical emitter; a
program containing `TON(...)` routes to legacy and stays byte-identical.

**Commands/tests:** `pnpm check` 0 · `pnpm test` **142 passed, 1 skipped** · `pnpm
test:migration` 12 · `pnpm verify:legacy-parity` PASS (16, 0 unapproved) · `pnpm test:ir` 45 ·
`pnpm test:semantic` 14 · corpus 7/7 · roundtrip 6/6 · build OK.

**HONEST scope boundary:**
- Activated for the `compile()` registry path. The legacy `translate()` API still uses the
  legacy engine directly (the full `translate()` flip is order §16, gated on ALL supported
  families being canonical-active — not yet). So `translate()`-based corpus/round-trip are
  unaffected and green.
- Families still legacy_only: declarations, arrays_structures, conversions, timers, counters,
  copy_move, bit_operations, calls, function_blocks, ladder, project_metadata,
  hardware_mapping, unsupported_manual_port.
- **Pre-existing parser limitation surfaced:** multi-branch `CASE` mis-parses (the branch
  statement-list doesn't stop at the next label) — previously masked by the literal-fabrication
  fallback, now an explicit `PARSE_UNEXPECTED_TOKEN`. Parity fixtures use single-branch CASE.
  Fixing the CASE parser is deferred (protected-parser scope).

**Next:** migrate `declarations` (canonical type emission + var declarations) as family 4,
then timers/counters/copy_move/calls with semantic symbol+type resolution (order §9) before
the reset/RES and reusable-block families; the full `translate()` flip comes after all
baseline-supported families are canonical-active.

---

## Stage 3 (family 4) — Canonical production activation: declarations

**Status:** COMPLETE · **Commit:** `<stage3b>` (this commit)

**Files (new):** `server/compiler/lowering/st-decl-emitter.ts`. **Changed:**
`server/compiler/migration/{routing,families,fixtures,approvals}.ts`,
`tests/compiler/migration/production-routing.test.ts`, ledger.

**Architectural result:** `declarations` family is now `canonical_active`. `compile()`
emits **primitive** VAR/VAR_INPUT/... declarations via the canonical declaration emitter
(`canonicalDeclType` maps BOOL/SINT..LINT/USINT..ULINT/REAL/LREAL/TIME/STRING; grouped by
direction, deterministic). Array/structure/opaque/unresolved/FB-instance declarations are the
`arrays_structures` family (still legacy_only) — routing keeps those on the legacy engine, so
array-heavy corpus fixtures (e.g. 01_ARRAY100_AVERAGE) stay legacy and green.

**Verified:** a primitive `VAR cnt : DINT; ok : BOOL := 1; END_VAR cnt := cnt + 1;` compiles
via the canonical engine (emits the VAR block + body); an `ARRAY[0..9] OF DINT` declaration
routes to legacy.

**Commands/tests:** `pnpm check` 0 · `pnpm test` **143 passed, 1 skipped** · `pnpm
test:migration` 13 · `pnpm verify:legacy-parity` PASS (20 fixtures, 0 unapproved) · `pnpm
test:ir` 45 · `pnpm test:semantic` 14 · corpus 7/7 · roundtrip 6/6 · build OK.

**Minimum for this run — MET.** Four families are canonical-active in the `compile()`
production path for both Rockwell↔Mitsubishi directions: **expressions, assignments,
control_flow, declarations** — with canonical lowering, canonical emission, parity comparison,
approved-difference tracking, production-routing tests, and green corpus/round-trip.

**Remaining families (still legacy_only):** arrays_structures, conversions, timers, counters,
copy_move, bit_operations, calls, function_blocks, ladder, project_metadata, hardware_mapping,
unsupported_manual_port. The legacy `translate()` API is still the legacy engine (its flip is
gated on all supported families being active — order §16). Next: semantic symbol/type
resolution (order §9), then timers/counters/copy_move/calls, then the `translate()` flip.

---

## Stage 3 (CASE) — Multi-branch CASE parsing corrected

**Status:** COMPLETE · **Commit:** `<stage3case>` (this commit)

**Reverified start:** local==remote==`5249df0`, clean; baseline gate green.

**Files:** `server/compiler/parser.ts` (label-boundary lookahead + range labels),
`server/compiler/ir/expressions.ts` (RangeExpr), `server/compiler/ir/normalize.ts`,
`server/compiler/lowering/st-emitter.ts`, `server/compiler/migration/families.ts`,
`server/compiler/migration/{fixtures,approvals}.ts`,
`tests/compiler/semantic/case-parser.test.ts` (new), ledger.

**Architectural result:** the ST parser now correctly delimits multi-branch `CASE`. Added
`looksLikeCaseLabel()` — a structural (non-guessing) lookahead that ends a branch body at the
next `N:`/`N, M:`/`LO..HI:` label (an assignment `a := 1` is not mistaken for a label because
`a` is followed by `:=`, not `,`/`:`/`..`). Added range labels (`LO..HI`) end-to-end: parser
`RangeNode` → IR `RangeExpr` → canonical ST emitter (`lo..hi`) → coverage. The `cf_case`
parity fixture is now a **real multi-branch CASE** (comma labels + a range + ELSE), not the
single-branch workaround.

**Commands/tests:** `pnpm check` 0 · `pnpm test` **152 passed, 1 skipped** (9 new CASE tests:
two-branch, comma labels, range, ELSE, multi-statement bodies, nested CASE, nested IF,
cross-language emission, no-fabricated-literals) · corpus 7/7 · roundtrip 6/6 ·
`verify:legacy-parity` PASS (20, 0 unapproved) · build OK. Removed the multi-branch CASE
entry from KNOWN_LIMITATIONS.

**Honest status:** `control_flow` canonical emission now covers multi-branch CASE. The larger
items of this order — **mixed-program routing** (canonical families staying canonical when
interleaved with legacy families; nonzero corpus canonical nodes), full symbol/type
resolution, and the typed families — remain to be built; see below.

---

## Stage 2 — Mixed-program (hybrid) routing + Stage 12 corpus-migration

**Status:** COMPLETE · **Commit:** `<stage2mixed>` (this commit)

**Files (new):** `server/compiler/migration/hybrid.ts`, `scripts/verify-corpus-migration.ts`,
`tests/compiler/migration/hybrid.test.ts`. **Changed:** `registry/orchestrator.ts` (hybrid
routing), `migration/families.ts` (`statementFullyCanonical`), `contracts/compile.ts`
(`engine: "mixed"`), `package.json` (`verify:corpus-migration`), and the equivalence tests in
`contracts.test.ts` / `registry.test.ts` / `production-routing.test.ts` (updated to assert
mixed behavior instead of whole-program fallback).

**Architectural result — whole-program fallback REPLACED by per-statement routing:**
- `compileHybrid()` segments a routine's top-level statements into canonical vs legacy runs.
  Canonical runs are lowered+emitted directly from canonical IR (`st-emitter`). Legacy runs
  are emitted by the REAL legacy emitter (`emitMEL`/`emitAB`) called on the ORIGINAL AST
  subset for that run + the original source lines — NOT reconstructed source, NOT regex
  splicing. Segments are assembled in source order.
- **Structural inseparability handled honestly:** `statementFullyCanonical` recurses the whole
  subtree; a canonical-active statement (e.g. `IF`) that contains a legacy-only node (e.g. a
  timer) routes to legacy as a unit — the inner active nodes are NOT counted as canonical (no
  pretending). This fixed a real crash where the canonical emitter recursed into a nested
  `semantic_operation`.
- Declarations route per-block (all-primitive → canonical VAR; else legacy).
- `CompileResult.migration` now reports `engine: "canonical" | "legacy" | "mixed"` plus
  canonical/legacy node + segment counts and per-family execution.
- Pure-legacy programs (0 canonical nodes) still use the whole-program legacy bridge (so
  mapping/labels artifacts are preserved) — `compile(LEGACY_SRC) == translate(LEGACY_SRC)`.

**Real corpus execution (via `compile()` / `verify:corpus-migration`):**
| Fixture | engine | canonical | legacy |
|---|---|---|---|
| 01_ARRAY100_AVERAGE | canonical | 5 | 0 |
| 02_ARRAY2000_AVERAGE | canonical | 5 | 0 |
| 03_CHECK_SUM | canonical | 8 | 0 |
| 04_FEN20_DATA_MOVE | **mixed** | 19 | 3 |
| 05_HMI_ALARM_MESSAGE | canonical | 2 | 0 |
| tank_level_pid_loop | **mixed** | 16 | 2 |
| mel/runtime_basics | **mixed** | 3 | 15 |

**Every corpus fixture now executes a nonzero canonical node count; 3 fixtures execute BOTH
canonical and legacy segments in one compilation** (Stage 2 gate MET; nonnegotiable #2 MET).

**Commands/tests:** `pnpm check` 0 · `pnpm test` **161 passed, 1 skipped** · `pnpm
test:migration` 21 · `pnpm test:ir` 45 · `pnpm test:semantic` 23 · `pnpm verify:legacy-parity`
PASS (20, 0 unapproved) · `pnpm verify:corpus-migration` PASS (7 fixtures, 3 mixed, 0
whole-program-legacy) · corpus 7/7 · roundtrip 6/6 · build OK.

**Nonnegotiables from this order — status:** #1 mixed routing operational ✅ · #2 nonzero
corpus canonical nodes ✅ · #3 multi-branch CASE corrected ✅ · #10 no silent family fallback
✅ (inseparable statements route legacy as a unit, reported). Still open: #4 full symbol/type
resolution, #5 arrays/structures + conversions canonical-active, #6 timers/counters typed,
#7 semantic-loss records, #8 legacy `translate()` routed through the pipeline. These require
the semantic resolver + typed lowering and are the next work items.

**Honest status:** `compile()` uses mixed canonical/legacy routing. Legacy `translate()` is
still the whole-program legacy engine (Stage 11 flip pending — it needs the same hybrid path;
deferred to keep this commit verified and bounded).

---

## Typed Semantic Core — Stage 0: reconciliation (verified start state)

**Verified start:** branch `claude/happy-johnson-dy7zxl`, HEAD = remote HEAD =
`3fbf55d`, clean tree. CI run `30542034769` for `3fbf55d` = **completed/success**.

**Full gate at start (2026-07-30):** `pnpm install --frozen-lockfile` 0 · `pnpm check` 0 ·
`pnpm test` **161 passed, 1 skipped** · `pnpm verify:legacy-parity` PASS (20, 0 unapproved) ·
`pnpm verify:corpus-migration` PASS (7 fixtures, 3 mixed, 0 whole-program-legacy) · corpus
7/7 · roundtrip 6/6 · build OK.

This is the reconciled base for the Typed Semantic Core / Loss Enforcement / Legacy-API
Migration order. Work proceeds in small verified commits from here.

---

## Typed Semantic Core — Stage 1: scope/symbol/type resolution + conversion analysis

**Commit:** `d25c349`

**Files:** `server/compiler/semantic/{scopes,types,conversions,resolver,index}.ts`;
`migration/hybrid.ts` (resolveProgram wired after operation normalization);
`tests/compiler/semantic/typed-core.test.ts`.

**Result:** A deterministic, pure typed semantic core, CONNECTED to ordinary compilation.
`resolveProgram` resolves `symbol_ref → (symbolId = declaring node id, declared type)` and
propagates canonical types through member/array/unary/binary/comparison/logical/range; it
NEVER fabricates a resolved type (undeclared identifier stays unresolved; any expression over
an unresolved operand stays unresolved). `classifyConversion` assigns ConversionSafety
conservatively (IEEE754 exact-int range drives int→real widening vs precision_loss). Output is
neutral for active families (they format names/raw, not types), so parity/corpus are unchanged.

## Typed Semantic Core — Stage 2: structured semantic-loss records + honest completeness

**Files:** `server/compiler/loss/{records,index}.ts`; `migration/hybrid.ts` (collects
program losses); `registry/orchestrator.ts` (populates `semanticLosses`, derives
`completeness`, real `manualPortCount`/`warningCount`); `scripts/verify-semantic-loss.ts`;
`package.json` (`verify:semantic-loss`); `tests/compiler/semantic/loss-records.test.ts`;
`tests/compiler/contracts.test.ts` (honest assertion: AB_SRC's TON → loss + review_required).

**Result:** `CompileResult.semanticLosses` is now AUTHORITATIVE and never dishonestly empty.
Losses are classified from a node's disposition (lossy/manual_port/unsupported/synthesized),
never re-guessed; behavior-preserving dispositions (exact/equivalent_lowering) are NOT losses.
`completeness` is DERIVED from the records — a program carrying any real loss can never report
`executable_complete`. New `verify:semantic-loss` gate proves loss records and completeness
agree across the corpus.

**Corpus honesty report:** 01/02/03/05 executable_complete (0 losses) · 04_FEN20 & tank_pid
review_required (1 loss each; tank_pid manualPort=1 PID) · runtime_basics generated (legacy
equivalent-lowerings, 0 losses). 2 fixtures carry structured loss records.

**Gate:** check 0 · test **186 passed, 1 skipped** · verify:legacy-parity PASS (20,0) ·
verify:corpus-migration PASS (7, 3 mixed) · verify:semantic-loss PASS (7, 2 with losses) ·
corpus 7/7 · roundtrip 6/6 · build OK.

## Typed Semantic Core — Stage 3: fix vendor timer/counter field-access routing (correctness)

**Files:** `server/compiler/migration/families.ts`; `tests/compiler/migration/hybrid.test.ts`.

**Bug:** Mixed routing sent an assignment reading a timer/counter status/config field
(`RunTimer.DN`, `Ctr.ACC`, …) through the canonical path, which emits the member name
VERBATIM. The legacy emitters rewrite these across dialects (AB `.DN/.PRE/.ACC` ↔ IEC
`.Q/.PT/.ET/.PV/.CV`). Result: canonical output emitted `RunTimer.DN` where the Mitsubishi
target requires `RunTimer.Q` — semantically wrong output, uncaught by parity/corpus.

**Fix:** `expressionFullyCanonical` now treats a member access on a vendor-rewritten instance
field (DN/PRE/ACC/Q/PT/ET/PV/CV) as NOT canonically safe, so the statement routes to the
legacy engine which applies the correct target rewrite. Honest and conservative: it never
emits a wrong field name; plain struct members stay canonical. (Proper `instance_field`
modeling arrives with the timers/counters family activation.) Regression test added.

**Gate:** check 0 · test **187 passed, 1 skipped** · verify:legacy-parity PASS (20,0) ·
verify:corpus-migration PASS (7, 3 mixed) · verify:semantic-loss PASS · corpus 7/7 ·
roundtrip 6/6 · build OK.

## Typed Semantic Core — Stage 4: authoritative capability evaluation

**Files:** `server/compiler/capability/{evaluator,manifests,index}.ts`;
`server/compiler/languages/rockwell.ts` (manifest completed + a real drift fixed);
`server/compiler/migration/hybrid.ts` (capability pass wired in); `scripts/verify-capabilities.ts`;
`package.json` (`verify:capabilities`); `tests/compiler/semantic/capability.test.ts`.

**Result:** The per-target CapabilityManifest is now AUTHORITATIVE, not informational.
`applyCapabilityDispositions` re-stamps every semantic operation's disposition from the target
manifest (manifest-declared rules win; undeclared ops keep the normalization disposition —
never silently upgraded). A bridge (`IR_TO_CAPABILITY_KEY`) reconciles the two operation
taxonomies (IR snake_case ↔ contracts PascalCase); intentionally-unmapped ops (inline
`limit_test`, family-resolved resets) are explicit.

**Drift caught + fixed:** `verify:capabilities` found the rockwell (mel2ab) manifest declared
`TimerOnDelay: equivalent_lowering` while the AB emitter actually generates a manual-port
template (no named-arg FB invoke in AB) — corrected to `lossy`. The mitsubishi (ab2mel)
manifest was completed (added TimerOffDelay, SynchronousBlockCopy, MaskedMove, ProgramCall;
refreshed the stale "T#0ms placeholder" note). The gate now enforces: every emittable
operation maps to a capability key, is declared in the strict (ab2mel) target manifest, and its
manifest disposition equals the normalization disposition — the manifest and pipeline can no
longer drift unnoticed.

**Gate:** check 0 · test **193 passed, 1 skipped** · verify:legacy-parity PASS (20,0) ·
verify:corpus-migration PASS (7, 3 mixed) · verify:semantic-loss PASS · verify:capabilities
PASS (12 ops, 0 issues) · corpus 7/7 · roundtrip 6/6 · build OK.
