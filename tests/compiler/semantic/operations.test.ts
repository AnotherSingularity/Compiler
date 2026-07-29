import { describe, it, expect } from "vitest";
import { parseSTSource } from "../../../server/compiler/parser";
import { normalizeStProgram, validateProgram, serializedHash, RESERVED_VENDOR_MNEMONICS } from "../../../server/compiler/ir";
import { normalizeProgramOperations, mnemonicRule } from "../../../server/compiler/semantic";
import type { SemanticOperationNode } from "../../../server/compiler/ir/operations";

const CTX = { sourceId: "<t>", language: "rockwell-logix-st" as const };

function opProg(src: string) {
  return normalizeProgramOperations(normalizeStProgram("MAIN", parseSTSource(src), CTX));
}

function ops(program: ReturnType<typeof opProg>): SemanticOperationNode[] {
  const found: SemanticOperationNode[] = [];
  const walk = (list: unknown[]): void => {
    for (const s of list as Array<Record<string, unknown>>) {
      if (s.node === "semantic_operation") found.push(s as unknown as SemanticOperationNode);
    }
  };
  walk(program.routines[0].body);
  return found;
}

describe("Stage 2 — operation normalization", () => {
  it("maps COP → block_copy with canonical identity and mnemonic in provenance", () => {
    const p = opProg("COP(src, dst, 10);");
    const [op] = ops(p);
    expect(op.operation).toBe("block_copy");
    expect(op.vendorAnnotations?.mnemonic).toBe("COP");
    expect(op.disposition).toBe("equivalent_lowering");
    expect(op.args.map((a) => a.role)).toEqual(["source", "dest", "count"]);
  });

  it("maps TON → timer_on_delay (lossy)", () => {
    const [op] = ops(opProg("TON(RunTimer);"));
    expect(op.operation).toBe("timer_on_delay");
    expect(op.disposition).toBe("lossy");
  });

  it("maps CTU/CPS/MVM/LIM/PID/MSG/JSR to their canonical kinds", () => {
    const cases: Array<[string, string]> = [
      ["CTU(c);", "counter_up"],
      ["CPS(a, b, 4);", "synchronous_block_copy"],
      ["MVM(s, m, d);", "masked_move"],
      ["LIM(lo, x, hi);", "limit_test"],
      ["PID(loop);", "pid_control"],
      ["MSG(m);", "message_transfer"],
      ["JSR(Sub);", "routine_call"],
    ];
    for (const [src, expected] of cases) {
      const [op] = ops(opProg(src));
      expect(op.operation).toBe(expected);
    }
  });

  it("leaves unknown calls untouched", () => {
    const p = opProg("MyUserFunc(a, b);");
    expect(ops(p)).toHaveLength(0);
    expect(p.routines[0].body[0].node).toBe("call");
  });

  it("normalizes operations inside nested control flow", () => {
    const p = opProg("IF x THEN\n  COP(a, b, 2);\nEND_IF;");
    const cond = p.routines[0].body[0] as unknown as { branches: Array<{ body: Array<{ node: string }> }> };
    expect(cond.branches[0].body[0].node).toBe("semantic_operation");
  });

  it("produces IR that validates clean and uses no vendor mnemonic as identity", () => {
    const p = opProg("COP(src, dst, 10);\nTON(t);\nCTU(c);");
    expect(validateProgram(p)).toEqual([]);
    for (const op of ops(p)) expect(RESERVED_VENDOR_MNEMONICS.has(op.operation)).toBe(false);
  });

  it("preserves node ids (stable hashes for unaffected structure) and is pure", () => {
    const base = normalizeStProgram("MAIN", parseSTSource("COP(a, b, 1);"), CTX);
    const before = serializedHash(base);
    const out = normalizeProgramOperations(base);
    expect(serializedHash(base)).toBe(before); // input not mutated
    expect(out.routines[0].body[0].id).toBe(base.routines[0].body[0].id); // id preserved
  });

  it("mnemonicRule exposes the mapping table", () => {
    expect(mnemonicRule("cop")?.operation).toBe("block_copy");
    expect(mnemonicRule("nope")).toBeUndefined();
  });
});
