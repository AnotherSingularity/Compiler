# ARCHITECTURE — compiler design

This document describes the compiler's structure, the AST shape, and
the design decisions that produced the current emitter strategy. Read
this before modifying anything in `server/compiler/`.

---

## Pipeline

```
  source text (string)
        │
        ▼
  ┌────────────────┐
  │  tokenize()    │  parser.ts — character stream → Token[]
  └────────────────┘
        │
        ▼
  ┌────────────────┐
  │  Parser.parse  │  parser.ts — Token[] → ASTNode[]
  └────────────────┘
        │
        ▼
  ┌────────────────┐
  │  emitMEL  OR   │  emitter.ts / emitter-ab.ts —
  │  emitAB        │  ASTNode[] → string (target dialect ST)
  └────────────────┘
        │
        ▼
  output text + diagnostics + mapping + allocator state
```

The orchestrator is `server/translate.ts`. It catches exceptions from
each stage and produces a structured `FailureReport` rather than
crashing.

---

## Why a shared parser

Both Allen-Bradley and Mitsubishi Structured Text are dialects of
**IEC 61131-3**. The grammar is identical for >95% of constructs:
`IF/THEN/ELSE/END_IF`, `FOR/TO/DO/END_FOR`, `CASE/OF`, assignment,
arithmetic, comparison, member access, indexing, function calls,
function-block invocations. The differences are in **standard library**
(instruction names, member names) and **system-level conventions**
(device addressing, FB invocation patterns) — not in the grammar.

So one parser produces the AST. Two emitters handle the dialect-
specific rewrites. This is also why MEL → AB previously "worked" as a
regex pass — both languages tokenize the same way. The regex pass was
wrong not because the parse was wrong, but because string substitution
can't reverse FB-invocation decomposition or rewrite intrinsics
(BMOV ↔ COP, LIMIT ↔ LIM, EXPT ↔ `**`).

---

## Parser (server/compiler/parser.ts)

### Tokenizer

Handcoded character-by-character tokenizer. Produces `Token[]` with
`{type, value, line, col}`. Handles:

  - Whitespace (lines tracked)
  - `(* ... *)` block comments → COMMENT token
  - `// ...` line comments → LINE_COMMENT token
  - `T#5000ms` time literals → TIME_LITERAL
  - `16#FF`, `8#777`, `2#101`, decimal, decimal-with-exponent → NUMBER / REAL
  - `'string literals'` → STRING
  - Identifiers and keywords (KEYWORDS table maps to typed token)
  - Compound keywords (`END_IF`, `VAR_GLOBAL`, etc.) detected via lookahead
  - Operators: `:=`, `<>`, `<=`, `>=`, `**`, `..`, plus single-char punctuation

No external lexer library. ~150 lines.

### Parser

Recursive descent + precedence climbing for expressions. The class
keeps an index `pos` into the token array and exposes `peek()`,
`advance()`, `expect()`, `match()`, `consume()`.

Top-level entry: `parse()` returns `ASTNode[]` (program is a flat
statement list at top level — IEC 61131-3 doesn't require an outer
`PROGRAM ... END_PROGRAM` wrapper for ST routines).

Statement parsing dispatches on the first token: `VAR*` → `parseVarBlock`,
`IF` → `parseIf`, `FOR` → `parseFor`, etc. Otherwise an expression is
parsed; if followed by `:=`, it becomes an assign; otherwise a call.

Expression parsing uses precedence climbing:
```
OR → XOR → AND → NOT → comparison → ADD → MUL → POWER → unary → postfix → atom
```

The postfix layer handles `.member`, `.bitNumber`, `[index]`, and
`(args)`. Function-call form vs. FB-invoke form is disambiguated by
checking if the first argument inside `(...)` is `IDENT ASSIGN` —
that signals named-arg form, which produces an `fb_invoke` node.

### AST node types

```typescript
program       — top-level (currently unused; we return a statement list)
var_block     — VAR/VAR_GLOBAL/.../END_VAR with decls inside
var_decl      — name + (optional AT address) + type + (optional initial)
assign        — target := value
if            — condition + thenBlock + elsifBranches[] + elseBlock?
case          — selector + branches[{labels, block}] + elseBlock?
for           — variable + start + end + step? + body
while         — condition + body
repeat        — body + until
exit, return  — flow control
call          — positional-args call (also used for AB instructions
                that look like calls but are really statement-level)
fb_invoke     — named-args FB invocation: Inst(IN := x, PT := y)
function_call — same shape as call but appears as expression
binary_op     — arithmetic + and power (with op string: +, -, *, /, MOD, **)
unary_op      — - and NOT
compare       — = <> < <= > >=
logical       — AND OR XOR
ident         — bare identifier
literal       — int, real, bool, string, time (litType field)
member_access — .member
bit_access    — .N (where N is a number)
index         — [i, j, ...]
type_cast     — explicit type conversion (DINT_TO_REAL etc. handled as function_call)
comment       — preserved through emit
block         — explicit { ... } scope (rare)
```

### Optional `AT <address>` clause

Var decls support the IEC 61131-3 direct-address binding:
```
Pump_Cmd AT M1000 : BOOL;
Sensor   AT %IX0.0 : BOOL;
```

The parser consumes everything between `AT` and `:` as the address
string. emitMEL preserves and reuses this when allocating devices.
emitAB strips it (AB uses tag-based addressing, not direct-address).

---

## Emitter strategy

### Two emitters, one AST

`emitMEL(ast)` produces Mitsubishi GX Works2 ST. `emitAB(ast)` produces
Allen-Bradley Logix ST. Both walk the same AST but apply different
**rewrites** at three layers:

  1. **Member access** — timer/counter member names are dialect-specific
     (`.DN` ↔ `.Q`, `.PRE` ↔ `.PT`, `.ACC` ↔ `.ET`, `.PV` ↔ `.PRE`, etc.)
  2. **Instruction names** — `COP ↔ BMOV`, `LIM ↔ LIMIT`, `EXPT ↔ **`,
     etc. Implemented as a lookup table (`INSTRUCTION_REWRITES`) that
     maps name → emit function.
  3. **Untranslatables** — instructions with no dialect equivalent
     (`PID`, `PIDE`, `MSG`, motion instructions, MEL-side `OUT_M`, `PLS`,
     `CALL`, etc.) emit a structured block comment plus a `MANUAL_PORT`
     diagnostic.

### Why a rewrite table instead of pattern matching

Each instruction is a single-line entry in a `Record<string, fn>`:
```typescript
COP:  (args, e) => args.length >= 3
  ? `BMOV(${e(args[0])}, ${e(args[1])}, ${e(args[2])})`
  : `BMOV(${args.map(e).join(", ")})`,
```

This means adding a new mapping is one line. The closure receives the
arg list and a recursive `emit` callback. No central dispatcher. No
visitor inheritance. The cost is that mappings can't easily share
state — but the AB↔MEL mappings are stateless to begin with.

### Manual-port instances and the pre-pass

PID, PIDE, MSG, etc. operate on UDT-shaped instances (e.g.
`LevelControl` is a PID-typed tag). Any reference to a member of such
an instance (`LevelControl.SP`, `LevelControl.SWM`) is also
untranslatable because the underlying UDT doesn't exist on the target
side.

The emitter does a **pre-pass** over the entire AST to collect every
identifier that appears as the first argument to an untranslatable
instruction. Member access on those identifiers later in the walk
emits a `<Instance>_<Member>_MANUAL` placeholder identifier and raises
a `MANUAL_PORT` diagnostic.

This is necessary because the order of statements can put a `.SWM`
reference before the `PID(...)` call that establishes the manual-port
status.

### Why placeholders instead of comments

A previous version of the emitter wrapped manual-port assignments in
block comments:
```
(* MANUAL PORT: LevelControl.SP := SP_Operator — instance has no MEL equivalent *)
```

Problem: the RHS operand (`SP_Operator`) disappeared into a comment.
On round-trip MEL→AB, the parser stripped the comment and the operand
was lost from any symbol-tracking tooling.

Current strategy emits runnable code with the placeholder LHS and a
trailing inline note:
```
LevelControl_SP_MANUAL := SP_Operator;  (* MANUAL_PORT: original LHS was a member of manual-ported instance LevelControl *)
```

The operand `SP_Operator` survives in code form. The engineer
grep-replaces `_MANUAL` identifiers with their wired tag names.

### Timer FB invocations

AB issues `TON(MyTimer)` and the timer's IN signal comes from the rung
condition (RLL) or the surrounding ST IF block. MEL requires explicit
named arguments: `MyTimer(IN := <enable>, PT := <preset>)`. The mapping
is **asymmetric** — AB → MEL has to invent the IN signal from nothing,
MEL → AB has to drop the named-arg structure.

emitMEL emits the MEL form with placeholder identifiers:
```
(* AB call: TON(MyTimer) — enable + preset come from rung context in AB *)
MyTimer(IN := TODO_MyTimer_enable, PT := MyTimer.PT);
```

`MyTimer.PT` is the timer's PRE member (rewritten from `.PRE`).
`TODO_MyTimer_enable` is a placeholder identifier the engineer wires
to the actual enable signal. An `INFO` (or `WARN` for retentive TONR)
diagnostic surfaces the requirement.

emitAB does the reverse: an FB-invoke node decomposes into
direct-member writes (only `.PRE` is settable) + an IF-wrapped AB
instruction call:
```
RunTimer.PRE := T#5000ms;
IF RunMode THEN
  TON(RunTimer);
END_IF;
```

`.IN` is NOT a settable member in AB — it's the rung condition. The
IF-wrap encodes the MEL IN argument as a conditional execution.
Literal `TRUE`/`1` enables collapse the IF wrap; literal `FALSE`/`0`
resets collapse the RES guard.

### Device allocator (emitMEL only)

`Allocator` class tracks the next free Mitsubishi device address per
type:

  - BOOL → M1000+ (one per BOOL)
  - INT → D5000+ (one per INT)
  - DINT → D1000+ (two D-words per DINT, since DINT is 32-bit)
  - REAL → D9000+ (two D-words per REAL)
  - TIMER → T0+
  - COUNTER → C0+
  - STRING → D15000+ (41 D-words per STRING)
  - Unknown UDTs → fallback to DINT pool

Each allocation gets recorded; at end of emit, the allocator produces
`mappingYaml` and `labelsCsv` outputs for the user to import into the
target PLC project.

This is intentionally simplistic. Real Mitsubishi projects use
GX Works3 label-based addressing where the IDE auto-allocates devices,
so the allocator's purpose is mainly traceability for the engineer.

### Provenance comments

Every emitted statement gets a `// [AB→MEL] <input>:N | <orig>` line
comment before it. This is critical for engineers reviewing diffs —
they can map every line of translated output back to the source line
that produced it. The compiler stays auditable.

---

## Diagnostics

Every emit pass produces `Diagnostic[]`:
```typescript
{ severity: "INFO" | "WARN" | "MANUAL_PORT" | "ERROR",
  code: string,    // namespaced, e.g. "AB_MEL_TIMER_001"
  message: string,
  line: number }
```

Codes are stable identifiers used by the UI to filter and group
diagnostics. The full code table lives in the emitter source. Each
fixture's snapshot pins the set of codes produced — see
`tests/__snapshots__/corpus.test.ts.snap`.

Severity semantics:

  - `INFO` — best-effort translation succeeded; engineer should review
    for context-dependent correctness (e.g. timer IN signals)
  - `WARN` — translation succeeded but with caveats that may affect
    runtime behavior (e.g. retentive timer reset paths)
  - `MANUAL_PORT` — translation produced a placeholder; engineer must
    intervene before deploying
  - `ERROR` — translation failed; no usable output

The translate.ts orchestrator considers `MANUAL_PORT` outcomes as
"ok = true" because the emitted code is still useful as a starting
point. Only `ERROR` diagnostics set `ok = false`.

---

## Failure reports

When the parser throws or the emitter produces zero output for
non-empty input, translate.ts builds a `FailureReport`:

```typescript
{
  stage: "parser" | "emit_mel" | "emit_ab",
  error: string,
  traceback: string,
  sourceContext: string,   // ±3 lines around the error
  pipelineState: string,
  timestamp: string,
  direction: string,
  inputLines: number,
}
```

This is rendered in the UI as a "failure" tab of the output panel,
giving the user a structured diagnosis instead of a stack trace.

---

## What's deliberately NOT in here

  - **Type checking.** The parser doesn't track types. `LevelTX_Raw : INT`
    declared in a VAR block has no influence on how `LevelTX_Raw` is
    used elsewhere. This means we can't optimize bit-of-word operations
    based on actual underlying type, can't catch type mismatches at
    translation time, can't allocate based on usage. A future pass can
    add this with a symbol table; the current architecture won't fight
    it.

  - **Control-flow analysis.** No reachability check, no DCE, no
    constant folding. We emit what we parse.

  - **Multi-file projects.** Each translation handles one routine.
    Cross-routine references (UDT definitions in a separate file,
    `JSR` calls to subroutines) emit as opaque identifiers with
    diagnostic notes.

  - **Direct-execution.** The compiler does NOT validate the output
    against a real PLC simulator. The user is the final check.

Each of these is a legitimate future direction. None of them are
blocking the v1 utility — translating real industrial routines into
reviewable target-dialect code that engineers can finish by hand.
