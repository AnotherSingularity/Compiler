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

**Status:** COMPLETE · **Commit:** `<stage1>` (this commit)

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
