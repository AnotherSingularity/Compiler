/**
 * AB↔MEL Structured Text Translation — Pipeline Entry Point
 * 
 * Uses: parseSTSource() → AST → emitMEL() (IR walk, not regex)
 */

import { z } from "zod";
import { parseSTSource } from "./compiler/parser";
import { emitMEL } from "./compiler/emitter";

export interface Diagnostic {
  severity: "INFO" | "WARN" | "MANUAL_PORT" | "ERROR";
  code: string;
  message: string;
  line: number;
}

export interface TranslationResult {
  ok: boolean;
  output: string;
  diagnostics: Diagnostic[];
  mappingYaml: string;
  labelsCsv: string;
  stats: {
    inputLines: number;
    outputLines: number;
    warningCount: number;
    manualPortCount: number;
    translatedNodes: number;
  };
}

export function translate(
  source: string,
  direction: "ab2mel" | "mel2ab",
  options?: { memoryMap?: string; labelsCsv?: string }
): TranslationResult {
  const diagnostics: Diagnostic[] = [];
  const sourceLines = source.split("\n");
  const inputLines = sourceLines.length;
  const sourceFile = "<input>";

  try {
    // Parse source into AST
    const ast = parseSTSource(source);

    if (direction === "ab2mel") {
      // Walk AST and emit MEL
      const result = emitMEL(ast, sourceFile, sourceLines);
      return {
        ok: !result.diagnostics.some(d => d.severity === "ERROR"),
        output: result.output,
        diagnostics: result.diagnostics,
        mappingYaml: result.mappingYaml,
        labelsCsv: result.labelsCsv,
        stats: {
          inputLines,
          outputLines: result.output.split("\n").length,
          warningCount: result.diagnostics.filter(d => d.severity === "WARN").length,
          manualPortCount: result.diagnostics.filter(d => d.severity === "MANUAL_PORT").length,
          translatedNodes: result.translatedNodes,
        },
      };
    } else {
      // MEL → AB: for now, emit with AB-style member names
      // TODO: full MEL→AB emitter (reverse of emitMEL)
      const result = emitMEL(ast, sourceFile, sourceLines);
      // Post-process: reverse the member rewrites
      let output = result.output;
      output = output.replace(/\.Q\b/g, ".DN");
      output = output.replace(/\.PT\b/g, ".PRE");
      output = output.replace(/\.ET\b/g, ".ACC");
      output = output.replace(/\.PV\b/g, ".PRE");
      output = output.replace(/\.CV\b/g, ".ACC");
      output = output.replace(/BTEST\((\w+),\s*(\d+)\)/g, "$1.$2");
      output = output.replace(/EXPT\((\w+),\s*(\w+)\)/g, "$1 ** $2");
      output = output.replace(/\[AB→MEL\]/g, "[MEL→AB]");

      return {
        ok: !result.diagnostics.some(d => d.severity === "ERROR"),
        output,
        diagnostics: result.diagnostics,
        mappingYaml: result.mappingYaml,
        labelsCsv: result.labelsCsv,
        stats: {
          inputLines,
          outputLines: output.split("\n").length,
          warningCount: result.diagnostics.filter(d => d.severity === "WARN").length,
          manualPortCount: result.diagnostics.filter(d => d.severity === "MANUAL_PORT").length,
          translatedNodes: result.translatedNodes,
        },
      };
    }
  } catch (err: any) {
    diagnostics.push({
      severity: "ERROR",
      code: "AB_MEL_PARSE_001",
      message: `Parse error: ${err.message}`,
      line: 0,
    });
    return {
      ok: false,
      output: "",
      diagnostics,
      mappingYaml: "allocations: {}\n",
      labelsCsv: "Class,Label,DataType,Device,Comment",
      stats: { inputLines, outputLines: 0, warningCount: 0, manualPortCount: 0, translatedNodes: 0 },
    };
  }
}

export const translateInputSchema = z.object({
  direction: z.enum(["ab2mel", "mel2ab"]),
  source: z.string().min(1, "Source code is required"),
  options: z.object({ memoryMap: z.string().optional(), labelsCsv: z.string().optional() }).optional(),
});
export type TranslateInput = z.infer<typeof translateInputSchema>;
