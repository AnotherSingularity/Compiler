import { describe, it, expect } from "vitest";
import { normalizeStProgram } from "../../../server/compiler/ir/normalize";
import { resolveProgram } from "../../../server/compiler/semantic/resolver";
import { classifyConversion } from "../../../server/compiler/semantic/conversions";
import { arithmeticResultType } from "../../../server/compiler/semantic/types";
import { buildProgramScope, buildRoutineScope } from "../../../server/compiler/semantic/scopes";
import { parseSTSourceWithDiagnostics } from "../../../server/compiler/parser";
import { int, REAL32, REAL64, BOOL, unresolvedType } from "../../../server/compiler/ir/types";
import type { AssignmentStmt } from "../../../server/compiler/ir/statements";
import type { CanonicalType } from "../../../server/compiler/ir/types";

function program(src: string) {
  const ast = parseSTSourceWithDiagnostics(src).ast;
  return resolveProgram(normalizeStProgram("MAIN", ast, { sourceId: "<t>", language: "rockwell-logix-st" }));
}

function firstAssignment(src: string): AssignmentStmt {
  const p = program(src);
  const stmt = p.routines[0].body.find((s) => s.node === "assignment");
  if (!stmt) throw new Error("no assignment");
  return stmt as AssignmentStmt;
}

describe("Typed semantic core — scope + symbol resolution", () => {
  it("resolves a declared local to its declared type and a stable symbol id", () => {
    const p = program("VAR\n  cnt : DINT;\nEND_VAR\ncnt := cnt + 1;");
    const decl = p.routines[0].locals[0];
    const a = p.routines[0].body.find((s) => s.node === "assignment") as AssignmentStmt;
    expect(a.target.node).toBe("symbol_ref");
    if (a.target.node === "symbol_ref") {
      expect(a.target.symbolId).toBe(decl.id); // symbol id === declaring node id
      expect(a.target.type).toEqual(int(32, true));
    }
  });

  it("leaves an undeclared identifier unresolved (never guesses a type)", () => {
    const a = firstAssignment("x := y + 1;");
    expect(a.target.node).toBe("symbol_ref");
    if (a.target.node === "symbol_ref") {
      expect(a.target.symbolId).toBeUndefined();
      expect(a.target.type.kind).toBe("unresolved");
    }
  });

  it("is case-insensitive on identifiers (ST semantics) but preserves spelling", () => {
    const p = program("VAR\n  Motor : BOOL;\nEND_VAR\nmOtOr := TRUE;");
    const a = p.routines[0].body.find((s) => s.node === "assignment") as AssignmentStmt;
    if (a.target.node === "symbol_ref") {
      expect(a.target.name).toBe("mOtOr"); // spelling preserved
      expect(a.target.type).toEqual(BOOL); // still resolved
    }
  });

  it("is deterministic and pure (repeat resolution is identical, input untouched)", () => {
    const src = "VAR\n  a : INT;\n  b : REAL;\nEND_VAR\na := a + 1;\nb := b * 2.0;";
    const ast = parseSTSourceWithDiagnostics(src).ast;
    const base = normalizeStProgram("MAIN", ast, { sourceId: "<t>", language: "rockwell-logix-st" });
    const snapshot = JSON.stringify(base);
    const r1 = JSON.stringify(resolveProgram(base));
    const r2 = JSON.stringify(resolveProgram(base));
    expect(r1).toBe(r2);
    expect(JSON.stringify(base)).toBe(snapshot); // input not mutated
  });
});

describe("Typed semantic core — expression type propagation", () => {
  it("promotes integer arithmetic to the wider operand and reals over integers", () => {
    const p = program("VAR\n  i : INT;\n  d : DINT;\n  r : REAL;\nEND_VAR\nd := i + d;\nr := d + r;");
    const asgns = p.routines[0].body.filter((s) => s.node === "assignment") as AssignmentStmt[];
    expect(asgns[0].value.type).toEqual(int(32, true)); // INT + DINT → DINT
    expect(asgns[1].value.type).toEqual(REAL32); // DINT + REAL → REAL
  });

  it("keeps a binary expression unresolved when an operand is unresolved", () => {
    const a = firstAssignment("VAR\n  d : DINT;\nEND_VAR\nd := d + unknownVar;");
    expect(a.value.type.kind).toBe("unresolved");
  });

  it("types comparisons and logical expressions as BOOL", () => {
    const p = program("VAR\n  d : DINT;\n  f : BOOL;\nEND_VAR\nf := d > 0;");
    const a = p.routines[0].body.find((s) => s.node === "assignment") as AssignmentStmt;
    expect(a.value.type).toEqual(BOOL);
  });

  it("resolves a declared FOR-loop index and an implicit one to DINT", () => {
    const p = program("VAR\n  acc : DINT;\nEND_VAR\nFOR k := 0 TO 9 DO\n  acc := acc + k;\nEND_FOR;");
    const forStmt = p.routines[0].body.find((s) => s.node === "for");
    expect(forStmt).toBeTruthy();
    if (forStmt && forStmt.node === "for") {
      const inner = forStmt.body.find((s) => s.node === "assignment") as AssignmentStmt;
      // acc + k : k is the implicit loop index (DINT), acc is DINT → DINT
      expect(inner.value.type).toEqual(int(32, true));
    }
  });
});

describe("Typed semantic core — arithmeticResultType", () => {
  const U = unresolvedType();
  it("returns unresolved if either operand is unresolved", () => {
    expect(arithmeticResultType(U, int(16, true)).kind).toBe("unresolved");
    expect(arithmeticResultType(int(16, true), U).kind).toBe("unresolved");
  });
  it("signed if either operand signed", () => {
    expect(arithmeticResultType(int(16, false), int(32, true))).toEqual(int(32, true));
    expect(arithmeticResultType(int(16, false), int(8, false))).toEqual(int(16, false));
  });
  it("real dominates and widens", () => {
    expect(arithmeticResultType(int(64, true), REAL32)).toEqual(REAL32);
    expect(arithmeticResultType(REAL64, REAL32)).toEqual(REAL64);
  });
});

describe("Typed semantic core — classifyConversion", () => {
  const i16 = int(16, true), i32 = int(32, true), u16 = int(16, false);
  it("identity for equal types", () => {
    expect(classifyConversion(i16, int(16, true))).toBe("identity");
  });
  it("integer widening / narrowing / signedness", () => {
    expect(classifyConversion(i16, i32)).toBe("widening");
    expect(classifyConversion(i32, i16)).toBe("narrowing");
    expect(classifyConversion(i16, u16)).toBe("signedness_change");
    expect(classifyConversion(i32, u16)).toBe("narrowing");
  });
  it("int→real widening within exact range, precision_loss beyond", () => {
    expect(classifyConversion(i16, REAL32)).toBe("widening");
    expect(classifyConversion(int(32, true), REAL32)).toBe("precision_loss"); // 32 > 24-bit significand
    expect(classifyConversion(int(32, true), REAL64)).toBe("widening");
  });
  it("real→int narrows; real→real widens or loses precision", () => {
    expect(classifyConversion(REAL32, i32)).toBe("narrowing");
    expect(classifyConversion(REAL32, REAL64)).toBe("widening");
    expect(classifyConversion(REAL64, REAL32)).toBe("precision_loss");
  });
  it("bool↔int is reinterpretation; unresolved is vendor_defined; string is not clean", () => {
    expect(classifyConversion(BOOL, i16)).toBe("reinterpretation");
    expect(classifyConversion(unresolvedType(), i16)).toBe("vendor_defined");
    const str: CanonicalType = { kind: "string" };
    expect(classifyConversion(str, i16)).toBe("vendor_defined");
  });
});

describe("Typed semantic core — scope tables", () => {
  it("routine scope layers locals over program globals", () => {
    const p = normalizeStProgram("MAIN", parseSTSourceWithDiagnostics("VAR\n  local1 : INT;\nEND_VAR\nlocal1 := 1;").ast, {
      sourceId: "<t>",
      language: "rockwell-logix-st",
    });
    const prog = buildProgramScope(p);
    const routine = buildRoutineScope(prog, p.routines[0].locals, p.routines[0].id);
    expect(routine.resolve("LOCAL1")?.type).toEqual(int(16, true));
    expect(routine.resolve("nope")).toBeUndefined();
  });
});
