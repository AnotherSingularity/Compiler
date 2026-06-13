# INSTRUCTION_MAPPING — AB ↔ MEL reference

The canonical mapping table the compiler uses. Engineer-facing
reference for what gets translated, what's flagged, and what's left
manual. Each row corresponds to an entry in `INSTRUCTION_REWRITES` or
`UNTRANSLATABLE` in `emitter.ts` / `emitter-ab.ts`.

---

## Data movement

| Allen-Bradley           | Mitsubishi              | Notes                          |
|-------------------------|-------------------------|--------------------------------|
| `MOV(src, dst)`         | `dst := src;`           | Single-element move            |
| `CLR(x)`                | `x := 0;`               | Clear to zero                  |
| `COP(src, dst, n)`      | `BMOV(src, dst, n);`    | Block copy, n elements         |
| `CPS(src, dst, n)`      | `BMOV(src, dst, n);`    | Synchronous COP (no MEL distinction) |
| `FLL(val, dst, n)`      | `FMOV(val, dst, n);`    | Fill n elements with val       |
| `MVM(src, mask, dst)`   | *(not yet)*             | Masked move — see KNOWN_LIMITATIONS |

## Arithmetic

| Allen-Bradley           | Mitsubishi              | Notes                          |
|-------------------------|-------------------------|--------------------------------|
| `ABS(x)`                | `ABS(x)`                | IEC standard                   |
| `SQR(x)`, `SQRT(x)`     | `SQRT(x)`               | AB has two names; MEL standardizes |
| `CPT(dst, expr)`        | `dst := expr;`          | Compute (general expression)   |
| `a ** b`                | `EXPT(a, b)`            | Power operator (AB uses `**` infix) |

## Comparison

| Allen-Bradley           | Mitsubishi              | Notes                          |
|-------------------------|-------------------------|--------------------------------|
| `LIM(min, in, max)`     | `LIMIT(min, in, max)`   | Bounded range check            |
| `MEQ(src, mask, cmp)`   | `((src AND mask) = cmp)` | Masked equal — synthesized     |
| `EQU`, `NEQ`, `GRT`, `LES` | `=`, `<>`, `>`, `<`  | Use comparison operators       |

## Trig + transcendentals

AB uses 3-letter forms; MEL uses IEC standard names.

| Allen-Bradley           | Mitsubishi              |
|-------------------------|-------------------------|
| `SIN(x)`                | `SIN(x)`                |
| `COS(x)`                | `COS(x)`                |
| `TAN(x)`                | `TAN(x)`                |
| `ASN(x)`                | `ASIN(x)`               |
| `ACS(x)`                | `ACOS(x)`               |
| `ATN(x)`                | `ATAN(x)`               |
| `LN(x)`                 | `LN(x)`                 |
| `LOG(x)`                | `LOG(x)`                |

## Timers — members

Member rewrites apply automatically when the timer is the base of a
member access expression.

| AB member  | MEL member | Meaning                          |
|------------|------------|----------------------------------|
| `.PRE`     | `.PT`      | Preset (target) time             |
| `.ACC`     | `.ET`      | Accumulator / elapsed time       |
| `.DN`      | `.Q`       | Done output bit                  |
| `.EN`      | `.EN`      | Enable input (same in both)      |
| `.TT`      | *(no IEC)* | Timer-timing — has no direct IEC equivalent; synthesizable as `<timer>.EN AND NOT <timer>.Q` |

## Counters — members

| AB member  | MEL member | Meaning                          |
|------------|------------|----------------------------------|
| `.PRE`     | `.PV`      | Preset value                     |
| `.ACC`     | `.CV`      | Current value                    |
| `.DN`      | `.Q`       | Done output bit                  |
| `.CU`      | `.CU`      | Count-up input                   |
| `.CD`      | `.CD`      | Count-down input                 |

## Timer FB invocation

The form differs significantly between dialects.

**AB form (Logix ST):**
```
TON(MyTimer);     // enable from rung condition or surrounding IF
```

**MEL form (GX Works2 ST):**
```
MyTimer(IN := <enable>, PT := <preset>);
```

### AB → MEL

`TON(MyTimer)` emits:
```
(* AB call: TON(MyTimer) — enable + preset come from rung context in AB *)
MyTimer(IN := TODO_MyTimer_enable, PT := MyTimer.PT);
```

`TODO_MyTimer_enable` is a placeholder identifier the engineer wires
to the actual enable signal. `MyTimer.PT` is the timer's PRE member
rewritten from `.PRE`. Diagnostic: `AB_MEL_TIMER_002` (INFO).

`TONR(MyTimer)` (retentive) emits the same form but with diagnostic
`AB_MEL_TIMER_001` (WARN) noting the reset-path requirement.

### MEL → AB

`MyTimer(IN := RunMode, PT := T#5000ms)` emits:
```
RunTimer.PRE := T#5000ms;     // only .PRE is settable on AB timers
IF RunMode THEN
  TON(RunTimer);              // IN signal wraps the call in IF
END_IF;
```

Optimizations:
  - Literal `TRUE`/`1` IN → drop the IF wrap, emit `TON(...);` directly
  - Literal `FALSE`/`0` R → drop the `RES(...)` guard entirely

Diagnostic: `MEL_AB_FB_001` (MANUAL_PORT — verify generated AB
structure matches original MEL semantics).

## Counter FB invocation

Same pattern as timers. AB form: `CTU(MyCounter)`. MEL form:
`MyCounter(CU := <signal>, R := <reset>, PV := <preset>)`.

CTD uses `CD` and `LD`. CTUD uses both `CU` and `CD`.

## Untranslatable instructions

These produce a `MANUAL_PORT` diagnostic and a structured comment block
in the output instead of attempting any translation.

### Process control

| Instruction | Code               | Reason                                  |
|-------------|--------------------|-----------------------------------------|
| `PID`       | `AB_MEL_PID_001`   | Configure Mitsubishi PID loop (S(P).PID, QnUDV PID FB, or Process CPU PID instruction) |
| `PIDE`      | `AB_MEL_PID_001`   | Mitsubishi has no direct PIDE equivalent — split into Mitsubishi PID instructions or use Process CPU FBs |

For PID/PIDE, the emitter also flags any subsequent reference to a
member of the PID instance (e.g. `LevelControl.SP`) and emits a
placeholder identifier `<Instance>_<Member>_MANUAL`. The parameter list
is enumerated in the manual-port comment for engineer reference:

```
SP, SPHLimit, SPLLimit, SPProg, SPOper,
PV, PVHigh, PVLow,
OUT, OUTHLim, OUTLLim, CVHLimit, CVLLimit,
Kp, Ki, Kd, TI, TD,
DB, SWM, SO, MAXO, MINO, BIAS, ERR, UPD
```

### Messaging

| Instruction | Code              | Reason                                  |
|-------------|-------------------|-----------------------------------------|
| `MSG`       | `AB_MEL_MSG_001`  | Replace with SLMP frame, CC-Link IE Field client, or Ethernet/IP scanner instruction |

### Motion

| Instruction | Code                  | Reason                                |
|-------------|-----------------------|---------------------------------------|
| `MAOC`      | `AB_MEL_MOTION_001`   | Output cam — requires Simple Motion / MR-J5 |
| `MAM`       | `AB_MEL_MOTION_001`   | Absolute move — requires positioning module / QD75 / Simple Motion |
| `MAJ`       | `AB_MEL_MOTION_001`   | Axis jog                              |
| `MSO`       | `AB_MEL_MOTION_001`   | Servo on                              |
| `MAFR`      | `AB_MEL_MOTION_001`   | Axis fault reset                      |

### Program flow

| Instruction | Code               | Reason                                  |
|-------------|--------------------|-----------------------------------------|
| `JSR`       | `AB_MEL_FLOW_001`  | Convert to function call: `SubroutineName();` |
| `LBL`       | `AB_MEL_FLOW_002`  | MEL discourages labels in ST — restructure with IF/CASE/loop |
| `JMP`       | `AB_MEL_FLOW_002`  | Same — restructure control flow         |
| `TND`       | `AB_MEL_FLOW_003`  | MEL has no equivalent — use RETURN inside a function block |
| `SBR`       | `AB_MEL_FLOW_004`  | Express as MEL FUNCTION_BLOCK or FUNCTION |
| `RET`       | `AB_MEL_FLOW_005`  | Use MEL RETURN keyword                 |

### MEL → AB direction

The reverse direction also has untranslatables — Mitsubishi-specific
instructions with no AB equivalent.

| Instruction | Code                | Reason                                |
|-------------|---------------------|---------------------------------------|
| `OUT_M`     | `MEL_AB_BIT_001`    | Use AB bit-of-word write: `X.N := Y;` |
| `SET_M`     | `MEL_AB_BIT_002`    | Use AB OTL or `X.N := TRUE;`          |
| `RST_M`     | `MEL_AB_BIT_003`    | Use AB OTU or `X.N := FALSE;`         |
| `PLS`       | `MEL_AB_PULSE_01`   | Use AB ONS or BOOL rising-edge logic  |
| `PLF`       | `MEL_AB_PULSE_02`   | Use AB ONS with negated logic         |
| `CALL`      | `MEL_AB_FLOW_001`   | Use AB JSR or direct function call    |
| `FEND`      | `MEL_AB_FLOW_002`   | AB programs don't use explicit end markers |

## Bit-of-word — both directions

```
StatusWord.0 := Pump_Running;          // valid in both AB and MEL ST
flag := MODULE_INPUT.Data[1].5;        // bit READ valid in both
HMI_ABN[i].N := ABN_ARRAY[j];          // array element bit write — valid in both
```

GX Works2 ST natively supports `.N` bit-of-word syntax for both read
and write. Earlier compiler versions wrapped these in `BTEST`/`BSET`/
`BRST` function calls, which was unnecessary and bloated output. The
current compiler preserves the syntax in both directions.

## Type conversions

IEC 61131-3 type conversion functions (`DINT_TO_REAL`, `REAL_TO_INT`,
`SINT_TO_DINT`, etc.) are valid in both dialects and pass through
unchanged.

```
ControlValve_Raw := DINT_TO_INT(REAL_TO_DINT(ScaledValue));
```

Both AB Studio 5000 and Mitsubishi GX Works2 accept these forms.

## Variable declarations

```
VAR
  Pump_Cmd AT M1000 : BOOL;            // MEL form with device binding
  RawCount : INT;                       // AB form, tag-based
  RunTimer : TON;                       // FB instance — both
  Buf : ARRAY[0..9] OF INT;             // array — both
  Msg : STRING[80];                     // sized string — both
END_VAR
```

AB → MEL: emitMEL passes the declaration through, allocates a fresh
Mitsubishi device per variable, and emits `name AT <device> : <type>;`.
The mapping is captured in the output's `mappingYaml` and `labelsCsv`
fields.

MEL → AB: emitAB strips any `AT <device>` clause since AB doesn't use
direct addressing. The type is preserved as-is.
