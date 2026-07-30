import { describe, it, expect } from "vitest";
import { parseSTSourceWithDiagnostics } from "../../../server/compiler/parser";
import { normalizeStProgram } from "../../../server/compiler/ir/normalize";
import { emitStatements } from "../../../server/compiler/lowering/st-emitter";

const CTX = { sourceId: "<t>", language: "rockwell-logix-st" as const };

function caseNode(src: string) {
  const p = parseSTSourceWithDiagnostics(src);
  expect(p.partial).toBe(false);
  const prog = normalizeStProgram("M", p.ast, CTX);
  return prog.routines[0].body[0] as unknown as {
    node: string;
    branches: Array<{ labels: unknown[]; body: unknown[] }>;
    elseBody: unknown[] | null;
  };
}

describe("Stage 3 — multi-branch CASE parsing", () => {
  it("parses a two-branch case with one statement each", () => {
    const c = caseNode("CASE s OF\n  1:\n    a := 1;\n  2:\n    a := 2;\nEND_CASE;");
    expect(c.node).toBe("case");
    expect(c.branches).toHaveLength(2);
    expect(c.branches.every((b) => b.body.length === 1)).toBe(true);
  });

  it("parses comma-separated labels", () => {
    const c = caseNode("CASE s OF\n  1, 2, 3:\n    a := 1;\nEND_CASE;");
    expect(c.branches[0].labels).toHaveLength(3);
  });

  it("parses range labels (LO..HI)", () => {
    const c = caseNode("CASE s OF\n  4..8:\n    a := 1;\nEND_CASE;");
    expect((c.branches[0].labels[0] as { node: string }).node).toBe("range");
  });

  it("parses an ELSE (default) branch", () => {
    const c = caseNode("CASE s OF\n  1:\n    a := 1;\nELSE\n  a := 0;\nEND_CASE;");
    expect(c.elseBody).not.toBeNull();
    expect(c.elseBody).toHaveLength(1);
  });

  it("parses multi-statement branch bodies and stops at the next label", () => {
    const c = caseNode("CASE s OF\n  1:\n    a := 1;\n    b := 2;\n  2:\n    a := 3;\nEND_CASE;");
    expect(c.branches[0].body).toHaveLength(2);
    expect(c.branches[1].body).toHaveLength(1);
  });

  it("parses a nested CASE inside a branch", () => {
    const c = caseNode("CASE s OF\n  1:\n    CASE t OF\n      1:\n        a := 1;\n    END_CASE;\n  2:\n    a := 2;\nEND_CASE;");
    expect(c.branches).toHaveLength(2);
    expect((c.branches[0].body[0] as { node: string }).node).toBe("case");
  });

  it("parses a nested IF inside a branch", () => {
    const c = caseNode("CASE s OF\n  1:\n    IF x THEN\n      a := 1;\n    END_IF;\n  2:\n    a := 2;\nEND_CASE;");
    expect((c.branches[0].body[0] as { node: string }).node).toBe("conditional");
  });

  it("emits a full multi-branch CASE (comma + range + else) as valid ST, both directions", () => {
    const src = "CASE sel OF\n  0:\n    a := 1;\n  2, 3:\n    a := 2;\n  4..8:\n    a := 3;\nELSE\n  a := 0;\nEND_CASE;";
    const prog = normalizeStProgram("M", parseSTSourceWithDiagnostics(src).ast, CTX);
    for (const lang of ["mitsubishi-gx-st", "rockwell-logix-st"] as const) {
      const out = emitStatements(prog.routines[0].body as never, { language: lang }, "").join("\n");
      expect(out).toContain("2, 3:");
      expect(out).toContain("4..8:");
      expect(out).toContain("ELSE");
      expect(out).toContain("END_CASE;");
    }
  });

  it("does not fabricate literals when a branch statement follows a label (no partial parse)", () => {
    const p = parseSTSourceWithDiagnostics("CASE s OF\n  1:\n    a := 1;\n  2:\n    b := 2;\nEND_CASE;");
    expect(p.diagnostics).toHaveLength(0);
  });
});
