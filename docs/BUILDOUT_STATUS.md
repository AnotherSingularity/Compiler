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
