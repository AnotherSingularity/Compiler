(*
  Mitsubishi GX Works2 ST sample — exercises emitAB.
  Patterns: timer FB invoke, bit-of-word, BMOV, LIMIT, EXPT, member access
  on timer/counter using MEL names (.Q, .PT, .ET, .PV, .CV).
*)

VAR
  RunMode : BOOL;
  Pump_Cmd AT M1000 : BOOL;
  RawCount AT D5000 : INT;
  ScaledFlow AT D9000 : REAL;
  RunTimer AT T0 : TON;
  PartCount AT C0 : CTU;
  SourceBuf AT D2000 : ARRAY[0..9] OF INT;
  DestBuf AT D2010 : ARRAY[0..9] OF INT;
  StatusWord AT D6000 : DINT;
END_VAR

// Scale 4-20mA to engineering units
ScaledFlow := LIMIT(0.0, ((RawCount - 4000) * 100.0 / 16000.0), 100.0);

// Block move (MEL native)
BMOV(SourceBuf, DestBuf, 10);

// Timer FB invocation, MEL form
RunTimer(IN := RunMode, PT := T#5000ms);

// Counter FB invocation
PartCount(CU := Pump_Cmd, R := FALSE, PV := 100);

// Bit-of-word writes — should pass through unchanged
StatusWord.0 := Pump_Cmd;
StatusWord.1 := RunTimer.Q;

// Read timer ET (elapsed) into a real
ScaledFlow := DINT_TO_REAL(RunTimer.ET);

// EXPT (power) → AB **
ScaledFlow := EXPT(ScaledFlow, 2.0);

// Plain IF with bit-of-word read
IF StatusWord.0 AND RunTimer.Q THEN
  Pump_Cmd := TRUE;
ELSE
  Pump_Cmd := FALSE;
END_IF;
