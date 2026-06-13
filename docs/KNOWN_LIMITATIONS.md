# KNOWN LIMITATIONS — compiler v1

Honest accounting of what doesn't yet work, with priority and pointers
to where each fix would land. This is the v1.1 roadmap.

---

## Priority 1: instruction-set gaps

### MVM (masked move)

```
MVM(src, mask, dest);    // dest := (dest AND NOT mask) OR (src AND mask)
```

Currently passes through unchanged in both directions. Adding it is a
single entry in `INSTRUCTION_REWRITES` (emitter.ts):

```typescript
MVM: (args, e) =>
  args.length >= 3
    ? `${e(args[2])} := (${e(args[2])} AND NOT ${e(args[1])}) OR (${e(args[0])} AND ${e(args[1])})`
    : `MVM(${args.map(e).join(", ")})`,
```

No real Honda fixture uses it, so test coverage requires a new fixture.

### RES (reset)

```
RES(timer);     // resets a timer or counter
```

AB-specific. No mapping in current emitter. The MEL equivalent depends
on the timer kind:

  - For non-retentive TON: `timer.IN := FALSE;` clears the timer
  - For retentive TONR: typically `timer.PT := 0;` or
    `timer(IN := FALSE, PT := 0);`

Implementation needs a small dispatch on the instance's declared type.
Without type information, the safest emit is:

```typescript
RES: (args, e) =>
  args.length >= 1
    ? `${e(args[0])}.IN := FALSE; (* RES — verify reset semantics for retentive timers *)`
    : `(* RES with no operand *)`,
```

### BSL / BSR (bit shift left / right)

Shift-register instructions. AB syntax:

```
BSL(BitArray, Control, SourceBit, Length);
BSR(BitArray, Control, SourceBit, Length);
```

MEL has `SHL`/`SHR` for word-level shifts but no direct bit-shift-array
equivalent. Probably better as a `MANUAL_PORT` diagnostic until a real
fixture demands a translation.

### MVMT / FAL / FSC / FBC / DDT (file/array)

AB file/array instructions with no direct MEL equivalent. Currently
pass through. Should be moved to `UNTRANSLATABLE` with diagnostic
codes.

---

## Priority 2: parser hardening

### Soft-fail in `parseAtom`

`server/compiler/parser.ts:566`:

```typescript
// Fallback: skip unknown tokens
this.advance();
return { kind: "literal", value: t.value, litType: "int", line: t.line };
```

When the parser sees a token it doesn't recognize at an expression
position, it silently emits a fake `literal` node. This masks real
syntax errors. Should be:

```typescript
throw new Error(`Unexpected token ${t.type} ("${t.value}") at line ${t.line}`);
```

Risk: this might surface latent parse failures in fixtures we currently
think work. Mitigated by the corpus test suite — run after the change
and update fixtures that genuinely have non-IEC syntax (e.g., AB's
`#` prefix on tag references).

### Provenance line offset bug

The parser uses the line of the first token of a node as the node's
`line` field. For a multi-line `FOR` loop, the provenance line is the
line of the `FOR` keyword, not the body's actual lines. For nested
statements inside FOR, the inner statements show their own correct
lines (good), but the FOR's provenance can be off-by-a-few when the
loop spans many source lines.

This is cosmetic — the line shown in `// [AB→MEL] <input>:N` is
slightly misleading for control-flow nodes spanning many lines. Visible
in `01_ARRAY100_AVERAGE.st` where the FOR provenance says "line 3" but
the body spans lines 3–11.

### `PROGRAM ... END_PROGRAM` wrapper

The parser doesn't recognize `PROGRAM <name>` / `END_PROGRAM` block
syntax (rare in actual AB/MEL ST routine code, but valid IEC 61131-3).
Top-level `PROGRAM` tokens currently become identifier nodes. Add:

```typescript
if (t.type === "PROGRAM") return this.parseProgram();
```

with corresponding `parseProgram()` method.

### `FUNCTION_BLOCK` / `FUNCTION` definition wrapper

Same — IEC ST allows full FB/FN definitions inside ST code. Currently
unsupported. Honda corpus uses routine-level ST, not FB definitions,
so this hasn't been a blocker.

---

## Priority 3: type system

### No type tracking

The parser captures type names as opaque strings (`"BOOL"`, `"REAL"`,
`"ARRAY[0..9] OF INT"`). Nothing maintains a symbol table. Consequences:

  - Allocator can't optimize layout for actual usage
  - Bit-of-word vs. boolean array can't be distinguished by source
  - Type-conversion necessity can't be inferred (e.g., `DINT * REAL`)
  - Bit-access on a BOOL (which is a bug) can't be detected

A symbol-table pass between parser and emitter would unlock all of
the above. Place it as `server/compiler/typecheck.ts` that takes
`ASTNode[]` and returns `{ ast, symbols }`.

### Allocator is naive

Current allocator gives BOOL→M1000+, INT→D5000+, etc. Each variable
gets the next free address in its pool. This doesn't account for:

  - Same-name variables shadowed across scopes (they get distinct addresses)
  - Arrays — allocated as a single device, not a range. `ARRAY[0..99] OF INT`
    gets one D-word; should get 100.
  - UDTs — fall back to DINT-sized allocation (2 words), regardless of
    actual UDT size.
  - User-provided memory map overrides (the `memoryMap` option in
    `translateInputSchema` is not yet consumed).

Fix: extend `Allocator.allocate()` to accept a `count` parameter, and
parse array bounds out of the type string. Honor `memoryMap` option
when provided.

---

## Priority 4: PID translation strategy

Currently any PID/PIDE instance becomes a manual-port block. The
diagnostic enumerates all the parameters the engineer needs to
configure on the Mitsubishi side. This is honest but minimal.

A future direction: emit a **Mitsubishi PID block scaffold** with the
PIDE parameter map already filled in:

```
(* Mitsubishi PID setup for LevelControl — port from AB PIDE *)
LevelControl_SP    := 50.0;     (* was: LevelControl.SP *)
LevelControl_PV    := LevelTX;  (* was: LevelControl.PV — wire from process variable *)
LevelControl_OUT   := 0.0;      (* was: LevelControl.OUT — wire to output *)
LevelControl_Kp    := 1.0;      (* was: LevelControl.Kp — tune *)
LevelControl_Ki    := 0.1;      (* was: LevelControl.Ki — tune *)
LevelControl_Kd    := 0.0;      (* was: LevelControl.Kd — tune *)
S(P).PID(...);                  (* Mitsubishi process CPU PID call *)
```

Requires per-target choice (Q-series PID vs. iQ-R Process CPU vs.
QnUDV). Probably surface as a user option.

---

## Priority 5: round-trip improvements

### Asymmetric mappings (informational)

These mappings lose information by design:

  - `TONR(t)` → MEL FB invoke → AB `TON(t)` (retentive-ness lost)
  - `CPS(s,d,n)` → `BMOV(s,d,n)` → `COP(s,d,n)` (synchronous semantics lost)
  - PID instance members → `_MANUAL` placeholders → opaque identifiers
    (member names unrecoverable on reverse)

These are correctly diagnosed as INFO/WARN/MANUAL_PORT — the engineer
sees the loss in the diagnostic stream. The round-trip test's
"documented losses" filter handles them as expected.

If we wanted symmetric round-trip, we'd need to encode the lost
information in a comment annotation:

```
TON(MyTimer); (* @ab-retentive: TONR *)
```

Then the parser would preserve the annotation and emitMEL would
restore the original AB call form on reverse translation. Not yet
implemented; speculative.

---

## Priority 6: UDT / structure handling

### Struct member emit assumes direct access

The emitter handles `obj.member.member2` correctly as nested
`member_access` nodes. But it doesn't know whether `obj` is a BOOL,
DINT, custom UDT, or what. For an AB tag like `MODULE_INPUT.Data[0].0`
(struct → array → bit), the emit is right because the structure is
preserved.

For a MEL custom structure (`Pump.RunHours`), the emit also passes
through. Both languages support nested struct access, so this works in
the common case. It fails when the source uses a UDT name as a type in
`VAR` and that UDT has different definitions across dialects (AB's
`PID` type vs. MEL's `PIDPARAM` type). The current `manualPortInstances`
mechanism catches `PID`; other UDTs pass through with whatever member
names the source used.

### No UDT definition parsing

`TYPE ... END_TYPE` blocks (IEC 61131-3 user-defined type declarations)
are not parsed. If a routine includes a TYPE definition, it'll be
treated as a sequence of statements and probably fail.

The Honda corpus doesn't include type definitions (they live in the
L5K's `DATATYPE` section, not in the ST routine source). Fine for now.

---

## Priority 7: error recovery

When the parser throws, the entire translation fails. No partial output,
no skip-and-continue. For long routines with one broken statement, this
is harsh.

A future improvement: panic-mode recovery — on parser exception,
advance to the next `;` or block boundary and continue. Surface each
recovered error as a diagnostic but produce partial output.

Implementation cost: medium. Risk: false confidence (engineers might
trust output that has silent gaps). Probably worth doing with a
prominent warning banner.

---

## Priority 8: cross-routine translation

Currently every translation is single-routine. Real industrial projects
have:

  - Shared UDT definitions
  - Subroutine references (`JSR` to other routines)
  - Global tag database
  - I/O configuration

The compiler treats all cross-routine references as opaque identifiers.
For a v2, the right model is a **project compilation context** that
holds shared definitions and resolves references across files.

This is a larger architectural shift. Not on the v1.1 roadmap.

---

## Not limitations — by design

These are deliberate choices, not gaps:

  - **No automated PID tuning translation.** PID parameters are
    process-dependent; transferring `Kp`, `Ki`, `Kd` values blindly is
    dangerous. Engineer must retune.
  - **No code generation for ladder logic (RLL).** This is an ST-only
    compiler. Routines written in RLL must be converted to ST first
    (Studio 5000 / GX Works2 both support this).
  - **No optimization pass.** Output is verbose by design — provenance
    comments, parenthesization, explicit casts. Engineers reviewing
    translations want auditable, not compact.
  - **No real-time validation.** The compiler does not connect to a
    PLC, does not execute output, does not simulate.

These boundaries keep the tool's scope honest. Crossing any of them
turns it into a different product.
