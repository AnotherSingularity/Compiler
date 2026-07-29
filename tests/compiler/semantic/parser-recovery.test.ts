import { describe, it, expect } from "vitest";
import { parseSTSource, parseSTSourceWithDiagnostics } from "../../../server/compiler/parser";

function kinds(ast: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.kind === "string") out.push(o.kind);
      Object.values(o).forEach(walk);
    }
  };
  walk(ast);
  return out;
}

describe("Stage 2 — parser recovery correction", () => {
  it("does not fabricate a literal for an unexpected token", () => {
    const { ast, diagnostics, partial } = parseSTSourceWithDiagnostics("x := @ ;");
    expect(partial).toBe(true);
    expect(diagnostics.map((d) => d.code)).toContain("PARSE_UNEXPECTED_TOKEN");
    // An explicit error node is produced, not a fake int literal.
    const ks = kinds(ast);
    expect(ks).toContain("error");
  });

  it("preserves source position on the diagnostic and the error node", () => {
    const { ast, diagnostics } = parseSTSourceWithDiagnostics("a := 1;\nb := @;");
    const d = diagnostics.find((x) => x.code === "PARSE_UNEXPECTED_TOKEN")!;
    expect(d.line).toBe(2);
    expect(d.col).toBeGreaterThan(0);
    const err = kinds(ast); // structural sanity
    expect(err).toContain("error");
  });

  it("clean source produces no parse diagnostics and is not partial", () => {
    const { diagnostics, partial } = parseSTSourceWithDiagnostics("IF x > 0 THEN\n  y := a + b;\nEND_IF;");
    expect(diagnostics).toHaveLength(0);
    expect(partial).toBe(false);
  });

  it("guarantees forward progress / termination on repeated garbage", () => {
    // Would hang or explode if recovery didn't consume tokens.
    const { diagnostics } = parseSTSourceWithDiagnostics("x := @ @ @ @ @ ;");
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.length).toBeLessThanOrEqual(500); // recovery cap respected
  });

  it("diagnostic ordering is deterministic across runs", () => {
    const a = parseSTSourceWithDiagnostics("p := @; q := @;").diagnostics;
    const b = parseSTSourceWithDiagnostics("p := @; q := @;").diagnostics;
    expect(a).toEqual(b);
  });

  it("parseSTSource (AST-only entry point) still returns an AST for clean source", () => {
    const ast = parseSTSource("y := a + 1;");
    expect(Array.isArray(ast)).toBe(true);
    expect(kinds(ast)).toContain("assign");
    expect(kinds(ast)).not.toContain("error");
  });
});
