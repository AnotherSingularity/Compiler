(*
====================================================================
  TANK LEVEL PID CONTROL LOOP - Studio 5000 Structured Text
  ====================================================================
  Sources for syntax / instruction signatures:
    [1] Rockwell Publication 1756-PM007L-EN-P (Sep 2024) - ST grammar
    [2] Rockwell Publication 1756-RM003 - General Instructions Ref Manual
        (PID instruction, SCL, CPT, alarm structures)
    [3] Rockwell help file documented signature (cited on plctalk.net,
        Aug 2007 thread, and SolisPLC RSLogix5000 PID tutorial):
            PID(PID, ProcessVariable, Tieback, ControlVariable,
                PIDMasterLoop, InHoldBit, InHoldValue);

  This routine is intended to be assigned to a PERIODIC TASK
  (typical: 100 ms) per Rockwell's stated requirement that the PID
  instruction execute at a consistent rate. The PID structure's
  .UPD member must match the task period in seconds.

  ASSUMED TAG DATABASE (controller scope):
    LevelControl    : PID                       (PID structure)
    LevelTX_Raw     : INT  (alias to Local:1:I.Ch0Data)
    LevelTX         : REAL                      (scaled level, ft)
    ControlValve_Raw: INT  (alias to Local:2:O.Ch0Data)
    ControlValve    : REAL                      (CV, 0-100%)
    SP_Operator     : REAL                      (HMI setpoint)
    Mode_Auto       : BOOL                      (HMI: 1=Auto, 0=Man)
    Mode_Man        : BOOL
    ManualCV        : REAL                      (HMI manual output)
    Pump_Running    : BOOL                      (interlock)
    LevelHiAlm      : BOOL
    LevelLoAlm      : BOOL
    LevelHiHiAlm    : BOOL
    StatusWord      : DINT                      (HMI status bits)
    HiSP, LoSP, HiHiSP : REAL                   (alarm setpoints)
====================================================================
*)


(* -------------------------------------------------------------------
   1) ANALOG INPUT SCALING
   Convert raw 4-20mA (4000-20000 counts) to engineering units 0-30 ft
   Pattern from Rockwell Quick Start Guide to Using PID in Logix5000.
   ------------------------------------------------------------------- *)

LevelTX := ((LevelTX_Raw - 4000) * (30.0 - 0.0) / (20000 - 4000)) + 0.0;

(* Clamp to physical bounds in case of transmitter fault *)
IF LevelTX < 0.0 THEN
    LevelTX := 0.0;
ELSIF LevelTX > 30.0 THEN
    LevelTX := 30.0;
END_IF;


(* -------------------------------------------------------------------
   2) PROCESS VARIABLE ALARMS
   ------------------------------------------------------------------- *)

LevelHiHiAlm := (LevelTX >= HiHiSP);
LevelHiAlm   := (LevelTX >= HiSP) & (LevelTX < HiHiSP);
LevelLoAlm   := (LevelTX <= LoSP);


(* -------------------------------------------------------------------
   3) MODE HANDLING AND SETPOINT LOAD
   Bumpless transfer: when leaving Auto, freeze SP to current PV so
   operator restart doesn't bump the valve.
   ------------------------------------------------------------------- *)

IF Mode_Auto & Pump_Running THEN
    LevelControl.SP := SP_Operator;
    LevelControl.SWM := 0;                  (* Software Manual off *)
ELSIF Mode_Man OR NOT Pump_Running THEN
    LevelControl.SP := LevelTX;             (* track PV for bumpless *)
    LevelControl.SWM := 1;                  (* Software Manual on *)
    LevelControl.SO  := ManualCV;           (* operator-set output *)
END_IF;


(* -------------------------------------------------------------------
   4) PID INSTRUCTION
   Documented Rockwell signature - 7 operands.
   ------------------------------------------------------------------- *)

PID(LevelControl, LevelTX, 0, ControlValve, 0, 0, 0);


(* -------------------------------------------------------------------
   5) OUTPUT CLAMPING
   Belt-and-suspenders on top of the PID's internal MAXO/MINO.
   ------------------------------------------------------------------- *)

IF ControlValve > 100.0 THEN
    ControlValve := 100.0;
ELSIF ControlValve < 0.0 THEN
    ControlValve := 0.0;
END_IF;

(* Force closed if interlocks not satisfied *)
IF NOT Pump_Running OR LevelHiHiAlm THEN
    ControlValve := 0.0;
END_IF;


(* -------------------------------------------------------------------
   6) ANALOG OUTPUT SCALING
   0-100% to 4-20mA raw counts (4000-20000)
   ------------------------------------------------------------------- *)

ControlValve_Raw := DINT_TO_INT(REAL_TO_DINT(
    ((ControlValve - 0.0) * (20000 - 4000) / (100.0 - 0.0)) + 4000));


(* -------------------------------------------------------------------
   7) HMI STATUS WORD - bit-packed BOOLs into DINT for efficient
      Produced/Consumed tag transport.
   ------------------------------------------------------------------- *)

StatusWord.0 := Pump_Running;
StatusWord.1 := Mode_Auto;
StatusWord.2 := Mode_Man;
StatusWord.3 := LevelLoAlm;
StatusWord.4 := LevelHiAlm;
StatusWord.5 := LevelHiHiAlm;
StatusWord.6 := LevelControl.SWM;           (* PID in software manual *)
StatusWord.7 := LevelControl.DB;            (* in deadband *)
