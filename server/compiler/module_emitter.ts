/**
 * Emit an IO module map from extracted L5K modules.
 *
 * AB Studio 5000 modules are described by catalog number, slot, vendor,
 * product type/code, and revision. Mapping them to a Mitsubishi project
 * is NOT lexical — the user has to choose a Mitsubishi chassis and pick
 * equivalent IO modules (often QH42P/QY42P/QX42 series for legacy or
 * R-series for current GX Works 3 deployments).
 *
 * This emitter produces a YAML document the user reviews and fills in with
 * MEL target addresses. It preserves the AB-side identity (slot, catalog,
 * data sizes) so the migration is auditable.
 *
 * Output shape:
 *
 *   ie_ver: "2.25"
 *   controller: "H05_24_0506_1_V1"
 *   chassis:
 *     - name: Local
 *       catalog: 5069-L330ERMS2
 *       slot: 0
 *       safety_enabled: true
 *       major: 34
 *       minor: 11
 *   modules:
 *     - name: SLOT_01
 *       parent: Local
 *       slot: 1
 *       catalog: 5069-IB8S/A
 *       vendor: 1
 *       product_type: 35
 *       safety_enabled: true
 *       connections:
 *         - name: SafetyInput
 *           data_blocks: [InputData, OutputData]
 *           rpi_ms: 10        # if present in attrs
 *       mel_target_address: ""    # TODO: user fills in (e.g., X40-X4F)
 *       notes: ""
 */
import type { L5KModule } from "./l5k_extract";
/** YAML scalar quoting — minimal, just enough for this output. */
function ystr(s: string | null | undefined): string {
  if (s === null || s === undefined || s === "") return '""';
  if (/^[\w./\-+:]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
/** Heuristic — chassis controllers carry a Major rev and are parented to "Local". */
function isChassisController(m: L5KModule): boolean {
  return m.name === "Local"
    || (m.parent === "Local" && (m.catalogNumber.includes("L3") || m.catalogNumber.includes("L7") || m.catalogNumber.includes("L8")));
}
function emitModuleBlock(m: L5KModule, indent: string): string[] {
  const out: string[] = [];
  out.push(`${indent}- name: ${ystr(m.name)}`);
  out.push(`${indent}  parent: ${ystr(m.parent)}`);
  if (m.slot !== null) out.push(`${indent}  slot: ${m.slot}`);
  out.push(`${indent}  catalog: ${ystr(m.catalogNumber)}`);
  out.push(`${indent}  vendor: ${m.vendor}`);
  out.push(`${indent}  product_type: ${m.productType}`);
  out.push(`${indent}  product_code: ${m.productCode}`);
  out.push(`${indent}  revision: "${m.major}.${m.minor}"`);
  out.push(`${indent}  safety_enabled: ${m.safetyEnabled}`);
  if (m.connections.length > 0) {
    out.push(`${indent}  connections:`);
    for (const c of m.connections) {
      out.push(`${indent}    - name: ${ystr(c.name)}`);
      const rpiAttr = c.attrs.find(a => a.key === "RPI");
      if (rpiAttr) out.push(`${indent}      rpi_us: ${rpiAttr.value}`);
      if (c.dataBlocks.length > 0) {
        out.push(`${indent}      data_blocks: [${c.dataBlocks.map(b => ystr(b)).join(", ")}]`);
      }
    }
  }
  out.push(`${indent}  mel_target_address: ""    # TODO: assign MEL IO address (e.g., X40-X4F)`);
  out.push(`${indent}  notes: ""                 # TODO: any migration notes`);
  return out;
}
export function emitIoMapYaml(
  modules: L5KModule[],
  ieVer: string | null,
  controllerName: string | null,
): string {
  const out: string[] = [];
  out.push("# IO module map — extracted from L5K, requires user mapping to MEL.");
  out.push("# Each AB module identifies catalog, slot, vendor, and product family.");
  out.push("# Set mel_target_address per module before importing the labels CSV.");
  out.push("");
  out.push(`ie_ver: ${ystr(ieVer ?? "")}`);
  out.push(`controller: ${ystr(controllerName ?? "")}`);
  out.push("");
  // Chassis (Local + controllers)
  const chassis = modules.filter(isChassisController);
  if (chassis.length > 0) {
    out.push("chassis:");
    for (const m of chassis) {
      for (const line of emitModuleBlock(m, "  ")) out.push(line);
    }
    out.push("");
  }
  // Everything else
  const ioModules = modules.filter(m => !isChassisController(m));
  out.push("modules:");
  if (ioModules.length === 0) {
    out.push("  []");
  } else {
    for (const m of ioModules) {
      for (const line of emitModuleBlock(m, "  ")) out.push(line);
    }
  }
  return out.join("\n");
}
