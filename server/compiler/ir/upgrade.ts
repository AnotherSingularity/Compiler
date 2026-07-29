/**
 * IR schema upgrade registry.
 *
 * Only v1 exists today, but the registry makes future 1.x → 2.x migrations
 * explicit and refuses unknown/incompatible versions rather than silently
 * reinterpreting them (invariant G).
 */
import { IR_SCHEMA_VERSION } from "./version";
import type { CanonicalIrEnvelope } from "./serialize";

export class IrUpgradeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "IrUpgradeError";
    this.code = code;
  }
}

type UpgradeStep = (env: CanonicalIrEnvelope) => CanonicalIrEnvelope;

/** Registered upgrade steps keyed by the version they upgrade FROM. */
const UPGRADES = new Map<string, { to: string; step: UpgradeStep }>();

function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Bring an envelope up to the current IR_SCHEMA_VERSION.
 *  - Same version → returned unchanged.
 *  - Older, with a registered path → upgraded step by step.
 *  - Newer major, or unknown → rejected (never reinterpreted).
 */
export function upgradeEnvelope(env: CanonicalIrEnvelope): CanonicalIrEnvelope {
  const current = parseSemver(IR_SCHEMA_VERSION)!;
  const got = parseSemver(env.schemaVersion);
  if (!got) throw new IrUpgradeError("IR_INVALID_SCHEMA_VERSION", `unparseable version "${env.schemaVersion}"`);

  if (env.schemaVersion === IR_SCHEMA_VERSION) return env;

  // Reject a newer major (or newer minor/patch we don't understand).
  if (got[0] > current[0] || (got[0] === current[0] && (got[1] > current[1] || (got[1] === current[1] && got[2] > current[2])))) {
    throw new IrUpgradeError("IR_FUTURE_SCHEMA_VERSION", `envelope version ${env.schemaVersion} is newer than supported ${IR_SCHEMA_VERSION}`);
  }

  // Walk registered upgrade steps.
  let cur = env;
  const guard = new Set<string>();
  while (cur.schemaVersion !== IR_SCHEMA_VERSION) {
    if (guard.has(cur.schemaVersion)) throw new IrUpgradeError("IR_UPGRADE_LOOP", `upgrade loop at ${cur.schemaVersion}`);
    guard.add(cur.schemaVersion);
    const up = UPGRADES.get(cur.schemaVersion);
    if (!up) throw new IrUpgradeError("IR_NO_UPGRADE_PATH", `no upgrade registered from ${cur.schemaVersion}`);
    cur = up.step(cur);
    cur.schemaVersion = up.to;
  }
  return cur;
}

/** Register an upgrade step (used by future 1.x/2.x versions). */
export function registerUpgrade(from: string, to: string, step: UpgradeStep): void {
  if (UPGRADES.has(from)) throw new IrUpgradeError("IR_DUPLICATE_UPGRADE", `upgrade from ${from} already registered`);
  UPGRADES.set(from, { to, step });
}
