/**
 * Default registry factory (Phase 2).
 *
 * Explicitly registers the built-in language plugins. No hidden module-load
 * side effects — callers who want the built-ins call this; callers who want a
 * custom set construct a `LanguageRegistry` themselves.
 */
import { LanguageRegistry } from "./registry";
import {
  rockwellLogixStFrontend,
  rockwellLogixStBackend,
  rockwellL5kFrontend,
} from "../languages/rockwell";
import { mitsubishiGxStFrontend, mitsubishiGxStBackend } from "../languages/mitsubishi";

export function createDefaultRegistry(): LanguageRegistry {
  const registry = new LanguageRegistry();
  registry.registerFrontend(rockwellLogixStFrontend);
  registry.registerFrontend(rockwellL5kFrontend);
  registry.registerFrontend(mitsubishiGxStFrontend);
  registry.registerBackend(rockwellLogixStBackend);
  registry.registerBackend(mitsubishiGxStBackend);
  return registry;
}

/**
 * Process-wide default registry, created once on first use (lazy, not a
 * load-time side effect). Used by the compatibility adapter so the legacy
 * entry point routes through the registry.
 */
let cached: LanguageRegistry | null = null;
export function defaultRegistry(): LanguageRegistry {
  if (!cached) cached = createDefaultRegistry();
  return cached;
}
