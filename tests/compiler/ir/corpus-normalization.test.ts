import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { parseSTSource } from "../../../server/compiler/parser";
import {
  normalizeStProgram,
  validateProgram,
  serializedHash,
  buildEnvelope,
  serializeEnvelope,
  parseEnvelope,
  RESERVED_VENDOR_MNEMONICS,
} from "../../../server/compiler/ir";

const FIXTURE_DIR = join(__dirname, "../../corpus/fixtures");
const CTX = { sourceId: "corpus", language: "rockwell-logix-st" as const };

function stFixtures(): string[] {
  return readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".st"));
}

describe("Stage 1 — corpus normalization", () => {
  const fixtures = stFixtures();

  it("has fixtures to exercise", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const file of fixtures) {
    describe(file, () => {
      const src = readFileSync(join(FIXTURE_DIR, file), "utf8");
      const program = normalizeStProgram(file, parseSTSource(src), CTX);

      it("normalizes to a valid IR program", () => {
        expect(validateProgram(program)).toEqual([]);
      });

      it("normalization is deterministic (stable serialized hash + ids)", () => {
        const again = normalizeStProgram(file, parseSTSource(src), CTX);
        expect(serializedHash(program)).toBe(serializedHash(again));
        expect(program.routines[0].id).toBe(again.routines[0].id);
      });

      it("round-trips through the envelope byte-stably", () => {
        const env = buildEnvelope(program, "0.1.0");
        const json = serializeEnvelope(env);
        const back = parseEnvelope(json);
        expect(serializedHash(back.program)).toBe(env.hashes.serialized);
      });

      it("contains no vendor mnemonic as a canonical operation identity", () => {
        const json = serializeEnvelope(buildEnvelope(program, "0.1.0"));
        const parsed = JSON.parse(json);
        const ops: string[] = [];
        const walk = (v: unknown): void => {
          if (Array.isArray(v)) return v.forEach(walk);
          if (v && typeof v === "object") {
            const o = v as Record<string, unknown>;
            if (o.node === "semantic_operation" && typeof o.operation === "string") ops.push(o.operation);
            Object.values(o).forEach(walk);
          }
        };
        walk(parsed);
        for (const op of ops) expect(RESERVED_VENDOR_MNEMONICS.has(op)).toBe(false);
      });
    });
  }
});
