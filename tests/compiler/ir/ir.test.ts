import { describe, it, expect } from "vitest";
import { parseSTSource } from "../../../server/compiler/parser";
import {
  IR_SCHEMA_VERSION,
  buildEnvelope,
  serializeProgram,
  serializeEnvelope,
  parseEnvelope,
  assertPlainData,
  IrSerializationError,
  validateProgram,
  validateEnvelope,
  serializedHash,
  semanticHash,
  normalizeStProgram,
  nodeIdFromPath,
  upgradeEnvelope,
  IrUpgradeError,
  type CanonicalProgram,
} from "../../../server/compiler/ir";

const CTX = { sourceId: "<t>", language: "rockwell-logix-st" as const };

function prog(src: string): CanonicalProgram {
  return normalizeStProgram("MAIN", parseSTSource(src), CTX);
}

const SRC = "IF x > 0 THEN\n  y := a + b * 2;\nELSE\n  y := 0;\nEND_IF;";

describe("Stage 1 — canonical IR", () => {
  describe("schema + envelope", () => {
    it("builds an envelope with schema tag, version, and both hashes", () => {
      const env = buildEnvelope(prog(SRC), "0.1.0");
      expect(env.schema).toBe("plc-canonical-ir");
      expect(env.schemaVersion).toBe(IR_SCHEMA_VERSION);
      expect(env.hashes.semantic).toMatch(/^[0-9a-f]{64}$/);
      expect(env.hashes.serialized).toMatch(/^[0-9a-f]{64}$/);
    });

    it("round-trips through serialize/parse", () => {
      const env = buildEnvelope(prog(SRC), "0.1.0");
      const json = serializeEnvelope(env);
      const back = parseEnvelope(json);
      expect(back.program.name).toBe("MAIN");
      expect(serializedHash(back.program)).toBe(env.hashes.serialized);
    });

    it("rejects an unknown schema tag on parse", () => {
      const env = buildEnvelope(prog(SRC), "0.1.0");
      const bad = JSON.parse(serializeEnvelope(env));
      bad.schema = "nope";
      expect(() => parseEnvelope(JSON.stringify(bad))).toThrow(IrSerializationError);
    });
  });

  describe("serialization determinism", () => {
    it("produces byte-identical JSON for equivalent IR", () => {
      expect(serializeProgram(prog(SRC), "0.1.0")).toBe(serializeProgram(prog(SRC), "0.1.0"));
    });

    it("hashes are stable across repeated normalization", () => {
      expect(serializedHash(prog(SRC))).toBe(serializedHash(prog(SRC)));
      expect(semanticHash(prog(SRC))).toBe(semanticHash(prog(SRC)));
    });

    it("semantic hash ignores provenance-only differences", () => {
      const a = prog(SRC);
      const b = prog(SRC);
      // perturb a source span offset (provenance only) — semantic hash unchanged
      b.routines[0].origin = { ...b.routines[0].origin, span: { sourceId: "<t>", start: { offset: 999, line: 1, column: 1 }, end: { offset: 999, line: 1, column: 1 } } } as never;
      expect(semanticHash(a)).toBe(semanticHash(b));
      expect(serializedHash(a)).not.toBe(serializedHash(b));
    });

    it("assertPlainData rejects functions, class instances, and cycles", () => {
      expect(() => assertPlainData({ a: () => 1 })).toThrow(IrSerializationError);
      class Foo {}
      expect(() => assertPlainData({ a: new Foo() })).toThrow(IrSerializationError);
      const cyc: Record<string, unknown> = {};
      cyc.self = cyc;
      expect(() => assertPlainData(cyc)).toThrow(IrSerializationError);
    });
  });

  describe("stable node ids", () => {
    it("nodeIdFromPath is deterministic and opaque", () => {
      expect(nodeIdFromPath("MAIN/routine[main]")).toBe(nodeIdFromPath("MAIN/routine[main]"));
      expect(nodeIdFromPath("a")).not.toBe(nodeIdFromPath("b"));
      expect(nodeIdFromPath("a")).toMatch(/^ir_[0-9a-f]{12}$/);
    });

    it("same source yields the same node ids", () => {
      const a = prog(SRC);
      const b = prog(SRC);
      expect(a.routines[0].id).toBe(b.routines[0].id);
      expect(a.routines[0].body[0].id).toBe(b.routines[0].body[0].id);
    });
  });

  describe("validation", () => {
    it("a normalized program validates clean", () => {
      expect(validateProgram(prog(SRC))).toEqual([]);
    });

    it("detects duplicate ids", () => {
      const p = prog("x := 1;\ny := 2;");
      p.routines[0].body[1].id = p.routines[0].body[0].id;
      const codes = validateProgram(p).map((d) => d.code);
      expect(codes).toContain("IR_DUPLICATE_ID");
    });

    it("detects unknown node kinds", () => {
      const p = prog(SRC);
      (p.routines[0].body[0] as unknown as { node: string }).node = "bogus";
      expect(validateProgram(p).map((d) => d.code)).toContain("IR_UNKNOWN_NODE");
    });

    it("detects invalid array bounds", () => {
      const p = prog("x := 1;");
      // inject an array type with lower > upper
      (p.globals as unknown[]).push({
        node: "var_decl", id: nodeIdFromPath("MAIN/g"), origin: { kind: "source", sourceId: "<t>", language: "rockwell-logix-st", artifactKind: "structured_text", span: { sourceId: "<t>", start: { offset: -1, line: 1, column: 1 }, end: { offset: -1, line: 1, column: 1 } } },
        name: "arr", direction: "global", storage: "normal", initial: null,
        type: { kind: "array", element: { kind: "boolean" }, dimensions: [{ lower: 5, upper: 0, inferred: false }] },
      });
      expect(validateProgram(p).map((d) => d.code)).toContain("IR_INVALID_ARRAY_BOUNDS");
    });

    it("detects a vendor mnemonic used as a semantic operation identity", () => {
      const p = prog("x := 1;");
      (p.routines[0].body as unknown[]).push({
        node: "semantic_operation", id: nodeIdFromPath("MAIN/op"), origin: { kind: "synthetic", generatedBy: "test", derivedFrom: [], reason: "t" },
        operation: "TON", args: [],
      });
      expect(validateProgram(p).map((d) => d.code)).toContain("IR_VENDOR_MNEMONIC_AS_IDENTITY");
    });

    it("detects broken synthetic references", () => {
      const p = prog("x := 1;");
      (p.routines[0].body as unknown[]).push({
        node: "noop", id: nodeIdFromPath("MAIN/n"), origin: { kind: "synthetic", generatedBy: "test", derivedFrom: ["ir_deadbeef0000"], reason: "t" },
      });
      expect(validateProgram(p).map((d) => d.code)).toContain("IR_BROKEN_REFERENCE");
    });

    it("validateEnvelope flags a wrong schema version", () => {
      const env = buildEnvelope(prog("x := 1;"), "0.1.0");
      env.schemaVersion = "9.9.9";
      expect(validateEnvelope(env).map((d) => d.code)).toContain("IR_INVALID_SCHEMA_VERSION");
    });
  });

  describe("upgrade framework", () => {
    it("passes through the current version unchanged", () => {
      const env = buildEnvelope(prog("x := 1;"), "0.1.0");
      expect(upgradeEnvelope(env)).toBe(env);
    });

    it("rejects a future schema version", () => {
      const env = buildEnvelope(prog("x := 1;"), "0.1.0");
      env.schemaVersion = "2.0.0";
      expect(() => upgradeEnvelope(env)).toThrow(IrUpgradeError);
    });

    it("rejects an older version with no registered upgrade path", () => {
      const env = buildEnvelope(prog("x := 1;"), "0.1.0");
      env.schemaVersion = "0.9.0";
      expect(() => upgradeEnvelope(env)).toThrow(IrUpgradeError);
    });
  });

  describe("provenance", () => {
    it("source nodes carry a source origin with a span", () => {
      const p = prog(SRC);
      const stmt = p.routines[0].body[0];
      expect(stmt.origin.kind).toBe("source");
      if (stmt.origin.kind === "source") {
        expect(stmt.origin.span.start.line).toBeGreaterThanOrEqual(1);
        expect(stmt.origin.sourceNodeKind).toBe("if");
      }
    });
  });
});
