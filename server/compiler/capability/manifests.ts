/**
 * Target-manifest selection.
 *
 * Returns the authoritative capability manifest for a target language — the
 * backend's own declared capabilities. Kept separate from the evaluator so the
 * evaluator stays free of backend imports (and unit-testable with hand-built
 * manifests).
 */
import type { LanguageId } from "../contracts/ids";
import type { CapabilityManifest } from "../contracts/capability";
import { mitsubishiGxStBackend } from "../languages/mitsubishi";
import { rockwellLogixStBackend } from "../languages/rockwell";

/** The capability manifest a target language's backend declares, or null. */
export function manifestForTarget(target: LanguageId): CapabilityManifest | null {
  switch (target) {
    case "mitsubishi-gx-st":
      return mitsubishiGxStBackend.capabilities();
    case "rockwell-logix-st":
      return rockwellLogixStBackend.capabilities();
    default:
      return null;
  }
}
