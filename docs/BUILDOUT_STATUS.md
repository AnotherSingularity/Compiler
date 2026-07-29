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

**Status:** COMPLETE · **Commit:** `<phase1>` (this commit)

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
