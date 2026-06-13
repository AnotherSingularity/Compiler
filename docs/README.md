# docs/

Documentation for the compiler-v1 drop. Read in this order if you're
new to the codebase or coming in via the Manus redeploy:

1. **CHANGELOG.md** — what changed in this drop, file by file
2. **HANDOFF.md** — deployment checklist, install, acceptance criteria
3. **ARCHITECTURE.md** — compiler design, AST shape, why decisions were made the way they were
4. **TESTING.md** — three test layers, how to run, when to update snapshots
5. **INSTRUCTION_MAPPING.md** — canonical AB ↔ MEL reference table
6. **KNOWN_LIMITATIONS.md** — what doesn't work yet, priority-ordered

---

## Quick reference

| If you want to...                          | Read              |
|--------------------------------------------|-------------------|
| Deploy the new compiler                    | HANDOFF.md        |
| Understand what shipped                    | CHANGELOG.md      |
| Modify the parser or an emitter            | ARCHITECTURE.md   |
| Add a new instruction mapping              | INSTRUCTION_MAPPING.md + TESTING.md |
| Add a new corpus fixture                   | TESTING.md        |
| Understand why something isn't translated  | KNOWN_LIMITATIONS.md |
| Debug a failing snapshot or round-trip     | TESTING.md (CI failure section) |

---

## Source-of-truth files

The docs describe behavior. The behavior is determined by:

  - `server/compiler/parser.ts`           — the grammar
  - `server/compiler/emitter.ts`          — AB → MEL rewrites
  - `server/compiler/emitter-ab.ts`       — MEL → AB rewrites
  - `server/translate.ts`                 — pipeline orchestrator
  - `tests/__snapshots__/corpus.test.ts.snap` — pinned outcomes

If a doc disagrees with the source files, the source files win.
Update the docs.
