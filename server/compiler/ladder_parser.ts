/**
 * Ladder Rung Parser
 *
 * Allen-Bradley exports ladder rungs in a mnemonic text form inside L5K
 * files. Each rung looks like a sequence of instructions, with parallel
 * branches in `[a, b, c]` brackets and series instructions juxtaposed.
 *
 * Examples:
 *   XIC(StartButton)OTE(MotorRun)
 *     → rung condition = StartButton, output = MotorRun := condition
 *
 *   [XIC(A) ,XIO(B) ]OTE(C)
 *     → rung condition = (A OR NOT B), output = C := condition
 *
 *   XIC(EStop)EQU(Speed,0)OTE(SafeToStart)
 *     → rung condition = EStop AND (Speed = 0), output = SafeToStart := condition
 *
 *   CPT(TOTAL,A+B*C)
 *     → unconditional compute, output = TOTAL := A+B*C
 *
 *   JSR(SubroutineName,0)
 *     → unconditional subroutine call (the trailing 0 is parameter count)
 *
 * This module produces a typed RungAst. The emitter (ladder_emitter.ts)
 * turns the AST into Structured Text.
 */
export type RungNode =
  | InstructionNode
  | BranchNode
  | SeriesNode;
/** A single instruction call: XIC(tag), MOV(src,dst), CPT(dst,expr), etc. */
export interface InstructionNode {
  kind: "Instruction";
  /** Uppercase mnemonic. AOI calls have the AOI name in uppercase. */
  name: string;
  /** Argument list. Each arg is a raw expression string preserved verbatim. */
  args: string[];
}
/** Parallel branches: [a, b, c] — at least one path must be true. */
export interface BranchNode {
  kind: "Branch";
  /** Each path is itself a SeriesNode (sequence of nodes ANDed together). */
  paths: SeriesNode[];
}
/** A series of nodes that AND together (or execute in sequence for outputs). */
export interface SeriesNode {
  kind: "Series";
  elements: RungNode[];
}
export interface RungAst {
  kind: "RungAst";
  /** Top-level node — usually a Series of contacts followed by outputs. */
  root: SeriesNode;
  /** Original text for diagnostic and round-trip. */
  source: string;
}
export interface ParseRungOptions {
  /** When true, throw on parse error; when false, return null and capture error. */
  strict?: boolean;
}
export interface ParseRungResult {
  ast: RungAst | null;
  error: string | null;
}
// ════════════════════════════════════════════════════════════════════════
// Tokenizer
// ════════════════════════════════════════════════════════════════════════
type TokenKind =
  | "IDENT"      // alphanumeric + underscore
  | "NUMBER"     // 123, 1.5, 16#FF, 2#0101, -123
  | "STRING"     // "..."
  | "LPAREN"
  | "RPAREN"
  | "LBRACKET"
  | "RBRACKET"
  | "COMMA"
  | "DOT"
  | "PLUS"
  | "MINUS"
  | "STAR"
  | "SLASH"
  | "PERCENT"
  | "EQ"
  | "NEQ"
  | "LT"
  | "GT"
  | "LE"
  | "GE"
  | "AMP"        // & (bitwise and rare in AB but seen)
  | "QUESTION"   // ? — placeholder argument
  | "AT"         // @ — used in some addressing modes
  | "EOF";
interface Token {
  kind: TokenKind;
  text: string;
  pos: number;
}
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  const len = input.length;
  while (pos < len) {
    const ch = input[pos];
    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      pos++;
      continue;
    }
    // String literal — both single and double quoted
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = pos;
      pos++;
      while (pos < len && input[pos] !== quote) {
        if (input[pos] === "$" && pos + 1 < len) {
          pos += 2; // skip escape sequence
          continue;
        }
        pos++;
      }
      pos++; // closing quote
      tokens.push({ kind: "STRING", text: input.slice(start, pos), pos: start });
      continue;
    }
    // Number — integer, real, hex, binary, with optional leading minus inside arglists
    if (/[0-9]/.test(ch) || (ch === "-" && pos + 1 < len && /[0-9]/.test(input[pos + 1]))) {
      const start = pos;
      if (ch === "-") pos++;
      while (pos < len && /[0-9]/.test(input[pos])) pos++;
      // Hex form: 16#...
      if (pos < len && input[pos] === "#") {
        pos++;
        while (pos < len && /[0-9a-fA-F_]/.test(input[pos])) pos++;
      } else {
        // Real form: 1.5 or 1.5e+10
        if (pos < len && input[pos] === ".") {
          pos++;
          while (pos < len && /[0-9]/.test(input[pos])) pos++;
        }
        if (pos < len && (input[pos] === "e" || input[pos] === "E")) {
          pos++;
          if (pos < len && (input[pos] === "+" || input[pos] === "-")) pos++;
          while (pos < len && /[0-9]/.test(input[pos])) pos++;
        }
      }
      tokens.push({ kind: "NUMBER", text: input.slice(start, pos), pos: start });
      continue;
    }
    // Identifier (instruction mnemonic or tag name)
    if (/[a-zA-Z_]/.test(ch)) {
      const start = pos;
      while (pos < len && /[a-zA-Z0-9_]/.test(input[pos])) pos++;
      tokens.push({ kind: "IDENT", text: input.slice(start, pos), pos: start });
      continue;
    }
    // Punctuation
    const two = input.slice(pos, pos + 2);
    if (two === "<=") { tokens.push({ kind: "LE", text: "<=", pos }); pos += 2; continue; }
    if (two === ">=") { tokens.push({ kind: "GE", text: ">=", pos }); pos += 2; continue; }
    if (two === "<>") { tokens.push({ kind: "NEQ", text: "<>", pos }); pos += 2; continue; }
    if (two === "**") { tokens.push({ kind: "STAR", text: "**", pos }); pos += 2; continue; }
    switch (ch) {
      case "(": tokens.push({ kind: "LPAREN",   text: ch, pos }); pos++; continue;
      case ")": tokens.push({ kind: "RPAREN",   text: ch, pos }); pos++; continue;
      case "[": tokens.push({ kind: "LBRACKET", text: ch, pos }); pos++; continue;
      case "]": tokens.push({ kind: "RBRACKET", text: ch, pos }); pos++; continue;
      case ",": tokens.push({ kind: "COMMA",    text: ch, pos }); pos++; continue;
      case ".": tokens.push({ kind: "DOT",      text: ch, pos }); pos++; continue;
      case "+": tokens.push({ kind: "PLUS",     text: ch, pos }); pos++; continue;
      case "-": tokens.push({ kind: "MINUS",    text: ch, pos }); pos++; continue;
      case "*": tokens.push({ kind: "STAR",     text: ch, pos }); pos++; continue;
      case "/": tokens.push({ kind: "SLASH",    text: ch, pos }); pos++; continue;
      case "%": tokens.push({ kind: "PERCENT",  text: ch, pos }); pos++; continue;
      case "=": tokens.push({ kind: "EQ",       text: ch, pos }); pos++; continue;
      case "<": tokens.push({ kind: "LT",       text: ch, pos }); pos++; continue;
      case ">": tokens.push({ kind: "GT",       text: ch, pos }); pos++; continue;
      case "&": tokens.push({ kind: "AMP",      text: ch, pos }); pos++; continue;
      case "?": tokens.push({ kind: "QUESTION", text: ch, pos }); pos++; continue;
      case "@": tokens.push({ kind: "AT",       text: ch, pos }); pos++; continue;
      case ";": pos++; continue; // statement terminator, ignored at rung level
    }
    // Unknown character — skip with a soft warning swallowed
    pos++;
  }
  tokens.push({ kind: "EOF", text: "", pos: len });
  return tokens;
}
// ════════════════════════════════════════════════════════════════════════
// Parser
// ════════════════════════════════════════════════════════════════════════
class RungParser {
  private tokens: Token[];
  private idx: number;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.idx = 0;
  }
  private peek(offset = 0): Token {
    return this.tokens[this.idx + offset] ?? this.tokens[this.tokens.length - 1];
  }
  private advance(): Token {
    return this.tokens[this.idx++];
  }
  private match(kind: TokenKind): boolean {
    if (this.peek().kind === kind) {
      this.idx++;
      return true;
    }
    return false;
  }
  private expect(kind: TokenKind): Token {
    const tok = this.peek();
    if (tok.kind !== kind) {
      throw new Error(`Expected ${kind} but got ${tok.kind} ("${tok.text}") at pos ${tok.pos}`);
    }
    return this.advance();
  }
  /** Parse an entire rung — a series at top level. */
  parseRung(): SeriesNode {
    return this.parseSeries(/* stopOnComma */ false);
  }
  /** A series is a sequence of instructions/branches that AND together. */
  private parseSeries(stopOnComma: boolean): SeriesNode {
    const elements: RungNode[] = [];
    while (this.peek().kind !== "EOF") {
      const tok = this.peek();
      if (tok.kind === "RBRACKET") break;
      if (tok.kind === "RPAREN") break;
      if (stopOnComma && tok.kind === "COMMA") break;
      if (tok.kind === "LBRACKET") {
        elements.push(this.parseBranch());
        continue;
      }
      if (tok.kind === "IDENT") {
        elements.push(this.parseInstruction());
        continue;
      }
      // Unknown — skip to make parsing resilient
      this.advance();
    }
    return { kind: "Series", elements };
  }
  /** [path1 , path2 , ...] — parallel branches, comma-separated. */
  private parseBranch(): BranchNode {
    this.expect("LBRACKET");
    const paths: SeriesNode[] = [];
    while (true) {
      paths.push(this.parseSeries(/* stopOnComma */ true));
      if (this.peek().kind === "COMMA") {
        this.advance();
        continue;
      }
      break;
    }
    this.expect("RBRACKET");
    return { kind: "Branch", paths };
  }
  /** INSTRUCTION(arg, arg, ...) — function-call syntax. */
  private parseInstruction(): InstructionNode {
    const nameTok = this.expect("IDENT");
    const name = nameTok.text.toUpperCase();
    // Some "instructions" appear without parens (e.g., labels) — handle gracefully
    if (!this.match("LPAREN")) {
      return { kind: "Instruction", name, args: [] };
    }
    const args = this.parseArgList();
    this.expect("RPAREN");
    return { kind: "Instruction", name, args };
  }
  /** Parse comma-separated argument list. Each arg is captured as raw text. */
  private parseArgList(): string[] {
    const args: string[] = [];
    if (this.peek().kind === "RPAREN") return args;
    while (true) {
      args.push(this.parseArgExpr());
      if (this.peek().kind === "COMMA") {
        this.advance();
        continue;
      }
      break;
    }
    return args;
  }
  /**
   * Parse a single argument expression. Args may contain arithmetic,
   * nested function calls (rare), tag refs with subscripts, etc.
   * We capture the verbatim source range to preserve original form.
   */
  private parseArgExpr(): string {
    const start = this.peek().pos;
    let depth = 0;
    let lastEnd = start;
    while (true) {
      const tok = this.peek();
      if (tok.kind === "EOF") break;
      if (depth === 0 && (tok.kind === "COMMA" || tok.kind === "RPAREN" || tok.kind === "RBRACKET")) break;
      if (tok.kind === "LPAREN" || tok.kind === "LBRACKET") depth++;
      if (tok.kind === "RPAREN" || tok.kind === "RBRACKET") depth--;
      lastEnd = tok.pos + tok.text.length;
      this.advance();
    }
    // Reconstruct from token text (loses original spacing but that's fine)
    // To get exact source, we'd need to pass input down; for now reconstruct.
    return this.tokens
      .slice(this.findIndexAtPos(start), this.idx)
      .map(t => t.text)
      .join(" ")
      .replace(/\s+([,.\[\]()])/g, "$1")
      .replace(/([,.\[\]()])\s+/g, "$1")
      .trim();
  }
  private findIndexAtPos(pos: number): number {
    for (let i = 0; i < this.tokens.length; i++) {
      if (this.tokens[i].pos === pos) return i;
    }
    return 0;
  }
}
// ════════════════════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════════════════════
export function parseRung(source: string, options: ParseRungOptions = {}): ParseRungResult {
  try {
    const tokens = tokenize(source);
    const parser = new RungParser(tokens);
    const root = parser.parseRung();
    return {
      ast: { kind: "RungAst", root, source },
      error: null,
    };
  } catch (err: any) {
    if (options.strict) throw err;
    return {
      ast: null,
      error: err?.message ?? String(err),
    };
  }
}
/**
 * Classify an instruction by its role in rung semantics. This drives the
 * emitter's translation strategy.
 */
export type InstructionRole =
  | "input_contact"   // XIC, XIO, ONS, OSR, OSF, AFI — contribute to rung condition
  | "compare"         // EQU, NEQ, LES, GRT, LEQ, GEQ, CMP, LIM — boolean expression
  | "output_coil"     // OTE, OTL, OTU — assign boolean output from rung condition
  | "output_action"   // MOV, ADD, CPT, COP, FLL, CLR, etc. — conditional action
  | "timer_counter"   // TON, TOF, RTO, CTU, CTD, RES — stateful instruction
  | "control_flow"    // JSR, JMP, LBL, RET, MCR, AFI, NOP, TND, SBR
  | "unsupported"     // Known AB built-in with no clean MEL equivalent (motion, PID, MSG)
  | "aoi_call"        // user-defined AOI invocation
  | "unknown";        // not yet supported
/**
 * Instructions that are AB built-ins with no direct Mitsubishi equivalent.
 * These get emitted as block comments preserving the original call form;
 * a controls engineer must port them by hand. The arguments are NOT emitted
 * as ST expressions (they often contain Rockwell-specific enum values like
 * "Units per sec" or "% of Maximum" that aren't valid ST identifiers).
 */
const UNSUPPORTED_BUILTINS = new Set<string>([
  // Motion — axis instructions
  "MAJ", "MAM", "MAS", "MAH", "MASD", "MASR", "MAFR", "MAG", "MCD",
  "MCS", "MGR", "MAW", "MCCD", "MCSV", "MDOC", "MDF", "MSO", "MSF",
  "MAOC", "MDCC", "MDSC", "MDSO", "MDST", "MAPC", "MAR", "MATC",
  "MDR", "MEMM", "MRP", "MRHD", "MSAT", "MAM", "MOC", "MAFR",
  // Motion — group instructions
  "MGSD", "MGSP", "MGSR", "MGS", "MGSP",
  // Motion — coordinate system
  "MCCM", "MCLM", "MCCD", "MCPM", "MCSD", "MCSR", "MCST", "MCT", "MCTO", "MCTP",
  // Process
  "PID", "PIDE", "PIDA", "BTR", "BTW", "IMC", "FTC", "RMPS", "SCL",
  "SOC", "TOT", "PMUL", "DEDT",
  // Communication
  "MSG", "CIPST", "IOT", "IOR",
  // Event
  "EVENT",
  // Special / equipment-phase
  "PPHASE", "PRNP", "PSC", "PXRQ", "PFL",
]);
const INSTRUCTION_ROLES: Record<string, InstructionRole> = {
  // Input contacts
  XIC: "input_contact",
  XIO: "input_contact",
  ONS: "input_contact",   // one-shot; needs stateful handling
  OSR: "input_contact",   // one-shot rising edge
  OSF: "input_contact",   // one-shot falling edge
  AFI: "input_contact",   // always false — entire rung disabled
  // Comparison (act as input contacts but with expression args)
  EQU: "compare",
  NEQ: "compare",
  LES: "compare",
  GRT: "compare",
  LEQ: "compare",
  GEQ: "compare",
  CMP: "compare",
  LIM: "compare",
  MEQ: "compare",
  // Output coils
  OTE: "output_coil",
  OTL: "output_coil",
  OTU: "output_coil",
  // Output actions
  MOV: "output_action",
  ADD: "output_action",
  SUB: "output_action",
  MUL: "output_action",
  DIV: "output_action",
  MOD: "output_action",
  CLR: "output_action",
  ABS: "output_action",
  SQR: "output_action",
  NEG: "output_action",
  CPT: "output_action",
  COP: "output_action",
  FLL: "output_action",
  GSV: "output_action",
  SSV: "output_action",
  CONCAT: "output_action",
  INSERT: "output_action",
  DELETE: "output_action",
  MID:    "output_action",
  FIND:   "output_action",
  // Timer / counter
  TON: "timer_counter",
  TOF: "timer_counter",
  RTO: "timer_counter",
  CTU: "timer_counter",
  CTD: "timer_counter",
  RES: "timer_counter",
  // Control flow
  JSR: "control_flow",
  JMP: "control_flow",
  LBL: "control_flow",
  RET: "control_flow",
  SBR: "control_flow",
  MCR: "control_flow",
  NOP: "control_flow",
  TND: "control_flow",
};
export function instructionRole(name: string): InstructionRole {
  const upper = name.toUpperCase();
  if (INSTRUCTION_ROLES[upper]) return INSTRUCTION_ROLES[upper];
  if (UNSUPPORTED_BUILTINS.has(upper)) return "unsupported";
  return "aoi_call";
}
