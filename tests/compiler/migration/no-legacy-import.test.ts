import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * The canonical lowering/emission layer must format lowered nodes only — it must
 * NOT import the legacy translator, source-language emitters, the parser, or the
 * compatibility bridge. This static check fails if those imports appear.
 */
const CANONICAL_MODULES = [
  "server/compiler/lowering/st-emitter.ts",
];

const FORBIDDEN = [
  /from\s+["'].*\/translate["']/,
  /from\s+["'].*\/emitter["']/,
  /from\s+["'].*\/emitter-ab["']/,
  /from\s+["'].*\/legacy-bridge["']/,
  /from\s+["'].*\/parser["']/,
];

describe("Stage 3 — canonical emitter isolation", () => {
  for (const rel of CANONICAL_MODULES) {
    it(`${rel} does not import the legacy engine / parser / bridge`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      for (const pat of FORBIDDEN) {
        expect(pat.test(src), `${rel} matched forbidden import ${pat}`).toBe(false);
      }
    });
  }
});
