import { describe, it, expect } from "vitest";
import { compileHybrid } from "../../../server/compiler/migration/hybrid";

const AB = "rockwell-logix-st" as const;
const MEL = "mitsubishi-gx-st" as const;
const ab = (s: string) => compileHybrid(s, AB, MEL)!;

describe("calls — canonical activation", () => {
  it("JSR(routine) -> portable routine call `routine();`", () => {
    const h = ab("JSR(MySubroutine);");
    expect(h.canonicalNodeCount).toBe(1);
    expect(h.legacyNodeCount).toBe(0);
    expect(h.output).toBe("MySubroutine();");
  });

  it("a plain function/routine call passes through canonically", () => {
    const h = ab("MyFunc(a, b);");
    expect(h.canonicalNodeCount).toBe(1);
    expect(h.output).toBe("MyFunc(a, b);");
  });

  it("a call stays canonical beside a legacy FB invoke (mixed)", () => {
    const h = ab("JSR(Sub);\nSomeFB(In := x);");
    expect(h.canonicalNodeCount).toBe(1);
    expect(h.legacyNodeCount).toBe(1);
    expect(h.output).toContain("Sub();");
  });

  it("a named-arg FB invocation stays legacy (function_blocks not yet active)", () => {
    const h = compileHybrid("RunTimer(IN := start, PT := T#5s);", MEL, AB)!;
    expect(h.legacyNodeCount).toBeGreaterThan(0);
  });
});
