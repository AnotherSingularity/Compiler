/**
 * IEC 61131-3 Structured Text Parser
 * Tokenizer + Recursive Descent → AST
 */
// === Token Types ===
export type TokenType =
  | "IDENT" | "NUMBER" | "REAL" | "STRING" | "TIME_LITERAL"
  | "ASSIGN" | "SEMI" | "COLON" | "COMMA" | "DOT" | "LPAREN" | "RPAREN"
  | "LBRACKET" | "RBRACKET" | "HASH"
  | "PLUS" | "MINUS" | "STAR" | "SLASH" | "POWER" | "AMP"
  | "EQ" | "NE" | "LT" | "LE" | "GT" | "GE"
  | "IF" | "THEN" | "ELSIF" | "ELSE" | "END_IF"
  | "CASE" | "OF" | "END_CASE"
  | "FOR" | "TO" | "BY" | "DO" | "END_FOR"
  | "WHILE" | "END_WHILE" | "REPEAT" | "UNTIL" | "END_REPEAT"
  | "AND" | "OR" | "XOR" | "NOT" | "MOD"
  | "TRUE" | "FALSE"
  | "VAR" | "VAR_GLOBAL" | "VAR_INPUT" | "VAR_OUTPUT" | "VAR_IN_OUT" | "END_VAR"
  | "FUNCTION_BLOCK" | "END_FUNCTION_BLOCK" | "FUNCTION" | "END_FUNCTION"
  | "PROGRAM" | "END_PROGRAM" | "RETURN" | "EXIT"
  | "DOTDOT" | "COMMENT" | "LINE_COMMENT" | "EOF";
export interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
}
// === Keywords ===
const KEYWORDS: Record<string, TokenType> = {
  IF: "IF", THEN: "THEN", ELSIF: "ELSIF", ELSE: "ELSE", END_IF: "END_IF",
  CASE: "CASE", OF: "OF", END_CASE: "END_CASE",
  FOR: "FOR", TO: "TO", BY: "BY", DO: "DO", END_FOR: "END_FOR",
  WHILE: "WHILE", END_WHILE: "END_WHILE",
  REPEAT: "REPEAT", UNTIL: "UNTIL", END_REPEAT: "END_REPEAT",
  AND: "AND", OR: "OR", XOR: "XOR", NOT: "NOT", MOD: "MOD",
  TRUE: "TRUE", FALSE: "FALSE",
  VAR: "VAR", VAR_GLOBAL: "VAR_GLOBAL", VAR_INPUT: "VAR_INPUT",
  VAR_OUTPUT: "VAR_OUTPUT", VAR_IN_OUT: "VAR_IN_OUT", END_VAR: "END_VAR",
  FUNCTION_BLOCK: "FUNCTION_BLOCK", END_FUNCTION_BLOCK: "END_FUNCTION_BLOCK",
  FUNCTION: "FUNCTION", END_FUNCTION: "END_FUNCTION",
  PROGRAM: "PROGRAM", END_PROGRAM: "END_PROGRAM",
  RETURN: "RETURN", EXIT: "EXIT",
};
// === Tokenizer ===
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let col = 1;
  while (pos < source.length) {
    // Whitespace
    if (/\s/.test(source[pos])) {
      if (source[pos] === "\n") { line++; col = 1; } else { col++; }
      pos++;
      continue;
    }
    // Block comment (* ... *)
    if (source[pos] === "(" && source[pos + 1] === "*") {
      const start = pos;
      const startLine = line;
      const startCol = col;
      pos += 2; col += 2;
      while (pos < source.length - 1 && !(source[pos] === "*" && source[pos + 1] === ")")) {
        if (source[pos] === "\n") { line++; col = 1; } else { col++; }
        pos++;
      }
      pos += 2; col += 2;
      tokens.push({ type: "COMMENT", value: source.slice(start, pos), line: startLine, col: startCol });
      continue;
    }
    // Line comment //
    if (source[pos] === "/" && source[pos + 1] === "/") {
      const start = pos;
      const startCol = col;
      while (pos < source.length && source[pos] !== "\n") { pos++; col++; }
      tokens.push({ type: "LINE_COMMENT", value: source.slice(start, pos), line, col: startCol });
      continue;
    }
    // Time literal T#...
    if ((source[pos] === "T" || source[pos] === "t") && source[pos + 1] === "#") {
      const start = pos;
      const startCol = col;
      pos += 2; col += 2;
      while (pos < source.length && /[0-9a-zA-Z_.]/.test(source[pos])) { pos++; col++; }
      tokens.push({ type: "TIME_LITERAL", value: source.slice(start, pos), line, col: startCol });
      continue;
    }
    // Number (integer or real). IEC 61131-3 allows underscore digit
    // separators inside numeric literals: 1_000, 16#FFFF_FFFF, 2#0001_0010.
    if (/[0-9]/.test(source[pos]) || (source[pos] === "1" && source[pos + 1] === "6" && source[pos + 2] === "#")) {
      const start = pos;
      const startCol = col;
      // Hex: 16#FF, binary: 2#01, octal: 8#77
      if (source.slice(pos, pos + 3).match(/^(16|8|2)#/)) {
        pos += 3; col += 3;
        while (pos < source.length && /[0-9A-Fa-f_]/.test(source[pos])) { pos++; col++; }
        tokens.push({ type: "NUMBER", value: source.slice(start, pos), line, col: startCol });
        continue;
      }
      while (pos < source.length && /[0-9_]/.test(source[pos])) { pos++; col++; }
      if (pos < source.length && source[pos] === "." && /[0-9]/.test(source[pos + 1])) {
        pos++; col++;
        while (pos < source.length && /[0-9_]/.test(source[pos])) { pos++; col++; }
        if (pos < source.length && /[eE]/.test(source[pos])) {
          pos++; col++;
          if (pos < source.length && /[+-]/.test(source[pos])) { pos++; col++; }
          while (pos < source.length && /[0-9]/.test(source[pos])) { pos++; col++; }
        }
        tokens.push({ type: "REAL", value: source.slice(start, pos), line, col: startCol });
      } else {
        tokens.push({ type: "NUMBER", value: source.slice(start, pos), line, col: startCol });
      }
      continue;
    }
    // String literal — IEC standard uses single quotes, but Allen-Bradley
    // L5K exports and certain Mitsubishi dialects use double quotes. Accept
    // both. Backslash escapes inside the string are passed through opaquely
    // (the emitter rewrites them as-needed).
    if (source[pos] === "'" || source[pos] === '"') {
      const quote = source[pos];
      const start = pos;
      const startCol = col;
      pos++; col++;
      while (pos < source.length && source[pos] !== quote) {
        if (source[pos] === "\\" && pos + 1 < source.length) {
          // Skip the escaped character so an embedded \' or \" doesn't end the string
          pos += 2; col += 2;
          continue;
        }
        if (source[pos] === "\n") { line++; col = 1; } else { col++; }
        pos++;
      }
      pos++; col++; // closing quote
      tokens.push({ type: "STRING", value: source.slice(start, pos), line, col: startCol });
      continue;
    }
    // Identifier or keyword
    if (/[a-zA-Z_]/.test(source[pos])) {
      const start = pos;
      const startCol = col;
      while (pos < source.length && /[a-zA-Z0-9_]/.test(source[pos])) { pos++; col++; }
      let value = source.slice(start, pos);
      // Check for compound keywords (END_IF, VAR_GLOBAL, etc.)
      if (pos < source.length && source[pos] === "_") {
        const lookAhead = source.slice(start, pos + 20).match(/^[a-zA-Z_]+/);
        if (lookAhead) {
          const compound = lookAhead[0].toUpperCase();
          if (KEYWORDS[compound]) {
            pos = start + lookAhead[0].length;
            col = startCol + lookAhead[0].length;
            value = lookAhead[0];
          }
        }
      }
      const upper = value.toUpperCase();
      const kwType = KEYWORDS[upper];
      tokens.push({ type: kwType || "IDENT", value, line, col: startCol });
      continue;
    }
    // Operators and punctuation
    const startCol = col;
    const ch = source[pos];
    const ch2 = source.slice(pos, pos + 2);
    if (ch2 === ":=") { tokens.push({ type: "ASSIGN", value: ":=", line, col: startCol }); pos += 2; col += 2; continue; }
    if (ch2 === "<>") { tokens.push({ type: "NE", value: "<>", line, col: startCol }); pos += 2; col += 2; continue; }
    if (ch2 === "<=") { tokens.push({ type: "LE", value: "<=", line, col: startCol }); pos += 2; col += 2; continue; }
    if (ch2 === ">=") { tokens.push({ type: "GE", value: ">=", line, col: startCol }); pos += 2; col += 2; continue; }
    if (ch2 === "**") { tokens.push({ type: "POWER", value: "**", line, col: startCol }); pos += 2; col += 2; continue; }
    if (ch2 === "..") { tokens.push({ type: "DOTDOT", value: "..", line, col: startCol }); pos += 2; col += 2; continue; }
    switch (ch) {
      case ";": tokens.push({ type: "SEMI", value: ";", line, col: startCol }); break;
      case ":": tokens.push({ type: "COLON", value: ":", line, col: startCol }); break;
      case ",": tokens.push({ type: "COMMA", value: ",", line, col: startCol }); break;
      case ".": tokens.push({ type: "DOT", value: ".", line, col: startCol }); break;
      case "(": tokens.push({ type: "LPAREN", value: "(", line, col: startCol }); break;
      case ")": tokens.push({ type: "RPAREN", value: ")", line, col: startCol }); break;
      case "[": tokens.push({ type: "LBRACKET", value: "[", line, col: startCol }); break;
      case "]": tokens.push({ type: "RBRACKET", value: "]", line, col: startCol }); break;
      case "+": tokens.push({ type: "PLUS", value: "+", line, col: startCol }); break;
      case "-": tokens.push({ type: "MINUS", value: "-", line, col: startCol }); break;
      case "*": tokens.push({ type: "STAR", value: "*", line, col: startCol }); break;
      case "/": tokens.push({ type: "SLASH", value: "/", line, col: startCol }); break;
      case "&": tokens.push({ type: "AMP", value: "&", line, col: startCol }); break;
      case "=": tokens.push({ type: "EQ", value: "=", line, col: startCol }); break;
      case "<": tokens.push({ type: "LT", value: "<", line, col: startCol }); break;
      case ">": tokens.push({ type: "GT", value: ">", line, col: startCol }); break;
      case "#": tokens.push({ type: "HASH", value: "#", line, col: startCol }); break;
      default:
        // Skip unknown characters
        break;
    }
    pos++; col++;
  }
  tokens.push({ type: "EOF", value: "", line, col });
  return tokens;
}
// === AST Node Types ===
export type ASTNode =
  | ProgramNode | VarBlockNode | VarDeclNode
  | AssignNode | IfNode | CaseNode | ForNode | WhileNode | RepeatNode
  | ExitNode | ReturnNode | CallNode | FBInvokeNode
  | BinaryOpNode | UnaryOpNode | CompareNode | LogicalNode
  | IdentNode | LiteralNode | MemberAccessNode | BitAccessNode
  | IndexNode | FunctionCallNode | TypeCastNode
  | CommentNode | BlockNode;
export interface ProgramNode { kind: "program"; name: string; varBlocks: VarBlockNode[]; body: ASTNode[]; line: number; }
export interface VarBlockNode { kind: "var_block"; scope: string; decls: VarDeclNode[]; line: number; }
export interface VarDeclNode { kind: "var_decl"; name: string; type: string; initial: ASTNode | null; line: number; }
export interface AssignNode { kind: "assign"; target: ASTNode; value: ASTNode; line: number; }
export interface IfNode { kind: "if"; condition: ASTNode; thenBlock: ASTNode[]; elsifBranches: Array<{ condition: ASTNode; block: ASTNode[] }>; elseBlock: ASTNode[] | null; line: number; }
export interface CaseNode { kind: "case"; selector: ASTNode; branches: Array<{ labels: ASTNode[]; block: ASTNode[] }>; elseBlock: ASTNode[] | null; line: number; }
export interface ForNode { kind: "for"; variable: string; start: ASTNode; end: ASTNode; step: ASTNode | null; body: ASTNode[]; line: number; }
export interface WhileNode { kind: "while"; condition: ASTNode; body: ASTNode[]; line: number; }
export interface RepeatNode { kind: "repeat"; body: ASTNode[]; until: ASTNode; line: number; }
export interface ExitNode { kind: "exit"; line: number; }
export interface ReturnNode { kind: "return"; line: number; }
export interface CallNode { kind: "call"; name: string; args: ASTNode[]; line: number; }
export interface FBInvokeNode { kind: "fb_invoke"; instance: string; args: Record<string, ASTNode>; line: number; }
export interface BinaryOpNode { kind: "binary_op"; op: string; left: ASTNode; right: ASTNode; line: number; }
export interface UnaryOpNode { kind: "unary_op"; op: string; operand: ASTNode; line: number; }
export interface CompareNode { kind: "compare"; op: string; left: ASTNode; right: ASTNode; line: number; }
export interface LogicalNode { kind: "logical"; op: string; left: ASTNode; right: ASTNode; line: number; }
export interface IdentNode { kind: "ident"; name: string; line: number; }
export interface LiteralNode { kind: "literal"; value: string; litType: "int" | "real" | "bool" | "string" | "time"; line: number; }
export interface MemberAccessNode { kind: "member_access"; object: ASTNode; member: string; line: number; }
export interface BitAccessNode { kind: "bit_access"; object: ASTNode; bit: number; line: number; }
export interface IndexNode { kind: "index"; array: ASTNode; indices: ASTNode[]; line: number; }
export interface FunctionCallNode { kind: "function_call"; name: string; args: ASTNode[]; line: number; }
export interface TypeCastNode { kind: "type_cast"; targetType: string; expr: ASTNode; line: number; }
export interface CommentNode { kind: "comment"; text: string; isBlock: boolean; line: number; }
export interface BlockNode { kind: "block"; statements: ASTNode[]; line: number; }
// === Parser ===
export class Parser {
  private tokens: Token[];
  private pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  private peek(): Token { return this.tokens[this.pos] || { type: "EOF", value: "", line: 0, col: 0 }; }
  private advance(): Token { return this.tokens[this.pos++]; }
  private expect(type: TokenType): Token {
    const t = this.peek();
    if (t.type !== type) throw new Error(`Expected ${type} but got ${t.type} ("${t.value}") at line ${t.line}`);
    return this.advance();
  }
  private match(...types: TokenType[]): boolean { return types.includes(this.peek().type); }
  private consume(type: TokenType): Token | null {
    if (this.peek().type === type) return this.advance();
    return null;
  }
  parse(): ASTNode[] {
    const stmts: ASTNode[] = [];
    while (!this.match("EOF")) {
      const node = this.parseTopLevel();
      if (node) stmts.push(node);
    }
    return stmts;
  }
  private parseTopLevel(): ASTNode | null {
    const t = this.peek();
    if (t.type === "COMMENT" || t.type === "LINE_COMMENT") {
      this.advance();
      return { kind: "comment", text: t.value, isBlock: t.type === "COMMENT", line: t.line };
    }
    if (["VAR", "VAR_GLOBAL", "VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT"].includes(t.type)) {
      return this.parseVarBlock();
    }
    return this.parseStatement();
  }
  private parseVarBlock(): VarBlockNode {
    const t = this.advance();
    const decls: VarDeclNode[] = [];
    while (!this.match("END_VAR", "EOF")) {
      if (this.match("COMMENT", "LINE_COMMENT")) { this.advance(); continue; }
      const decl = this.parseVarDecl();
      if (decl) decls.push(decl);
    }
    this.consume("END_VAR");
    this.consume("SEMI");
    return { kind: "var_block", scope: t.value.toUpperCase(), decls, line: t.line };
  }
  private parseVarDecl(): VarDeclNode | null {
    if (!this.match("IDENT")) return null;
    const name = this.advance();
    // Optional IEC 61131-3 direct-address clause:  IDENT AT %IX0.0 : ...
    // Mitsubishi GX Works2 uses bare device names without the % prefix:
    // IDENT AT M1000 : ...   IDENT AT D5000 : ...
    let directAddress: string | null = null;
    if (this.peek().type === "IDENT" && this.peek().value.toUpperCase() === "AT") {
      this.advance(); // consume AT
      const addrParts: string[] = [];
      // %IX0.0 style: percent, ident, optional dotted bit
      // M1000 style: ident
      // Read everything up to ':'
      while (!this.match("COLON", "EOF")) {
        addrParts.push(this.advance().value);
      }
      directAddress = addrParts.join("");
    }
    this.expect("COLON");
    // Type can be complex: ARRAY[0..10] OF DINT, STRING[80], etc.
    // The tokenizer ate whitespace, so re-insert a space before any token
    // that starts with a letter (the only case where adjacency would mash
    // identifiers/keywords together — punctuation runs like ARRAY[0..9]
    // are fine without spaces).
    const typeParts: string[] = [];
    while (!this.match("SEMI", "ASSIGN", "EOF")) {
      const tok = this.advance();
      const firstCh = tok.value.charAt(0);
      if (typeParts.length > 0 && /[A-Za-z_]/.test(firstCh)) {
        typeParts.push(" ");
      }
      typeParts.push(tok.value);
    }
    const typeName = typeParts.join("");
    let initial: ASTNode | null = null;
    if (this.consume("ASSIGN")) {
      initial = this.parseExpression();
    }
    this.consume("SEMI");
    return { kind: "var_decl", name: name.value, type: typeName.trim(), initial, line: name.line };
  }
  private parseStatement(): ASTNode | null {
    const t = this.peek();
    if (t.type === "COMMENT" || t.type === "LINE_COMMENT") {
      this.advance();
      return { kind: "comment", text: t.value, isBlock: t.type === "COMMENT", line: t.line };
    }
    if (t.type === "SEMI") { this.advance(); return null; }
    if (t.type === "IF") return this.parseIf();
    if (t.type === "CASE") return this.parseCase();
    if (t.type === "FOR") return this.parseFor();
    if (t.type === "WHILE") return this.parseWhile();
    if (t.type === "REPEAT") return this.parseRepeat();
    if (t.type === "EXIT") { this.advance(); this.consume("SEMI"); return { kind: "exit", line: t.line }; }
    if (t.type === "RETURN") { this.advance(); this.consume("SEMI"); return { kind: "return", line: t.line }; }
    // Assignment or call
    const expr = this.parseExpression();
    if (this.consume("ASSIGN")) {
      const value = this.parseExpression();
      this.consume("SEMI");
      return { kind: "assign", target: expr, value, line: t.line };
    }
    // Standalone expression (function call as statement)
    this.consume("SEMI");
    // If it's a function call, wrap as CallNode
    if (expr.kind === "function_call") {
      return { kind: "call", name: (expr as FunctionCallNode).name, args: (expr as FunctionCallNode).args, line: expr.line };
    }
    return expr;
  }
  private parseIf(): IfNode {
    const line = this.expect("IF").line;
    const condition = this.parseExpression();
    this.expect("THEN");
    const thenBlock = this.parseStatementList("ELSIF", "ELSE", "END_IF");
    const elsifBranches: Array<{ condition: ASTNode; block: ASTNode[] }> = [];
    while (this.consume("ELSIF")) {
      const cond = this.parseExpression();
      this.expect("THEN");
      const block = this.parseStatementList("ELSIF", "ELSE", "END_IF");
      elsifBranches.push({ condition: cond, block });
    }
    let elseBlock: ASTNode[] | null = null;
    if (this.consume("ELSE")) {
      elseBlock = this.parseStatementList("END_IF");
    }
    this.expect("END_IF");
    this.consume("SEMI");
    return { kind: "if", condition, thenBlock, elsifBranches, elseBlock, line };
  }
  private parseCase(): CaseNode {
    const line = this.expect("CASE").line;
    const selector = this.parseExpression();
    this.expect("OF");
    const branches: Array<{ labels: ASTNode[]; block: ASTNode[] }> = [];
    while (!this.match("ELSE", "END_CASE", "EOF")) {
      const labels: ASTNode[] = [];
      labels.push(this.parseExpression());
      while (this.consume("COMMA")) labels.push(this.parseExpression());
      this.expect("COLON");
      const block = this.parseStatementList("ELSE", "END_CASE");
      branches.push({ labels, block });
    }
    let elseBlock: ASTNode[] | null = null;
    if (this.consume("ELSE")) { elseBlock = this.parseStatementList("END_CASE"); }
    this.expect("END_CASE");
    this.consume("SEMI");
    return { kind: "case", selector, branches, elseBlock, line };
  }
  private parseFor(): ForNode {
    const line = this.expect("FOR").line;
    const variable = this.expect("IDENT").value;
    this.expect("ASSIGN");
    const start = this.parseExpression();
    this.expect("TO");
    const end = this.parseExpression();
    let step: ASTNode | null = null;
    if (this.consume("BY")) step = this.parseExpression();
    this.expect("DO");
    const body = this.parseStatementList("END_FOR");
    this.expect("END_FOR");
    this.consume("SEMI");
    return { kind: "for", variable, start, end, step, body, line };
  }
  private parseWhile(): WhileNode {
    const line = this.expect("WHILE").line;
    const condition = this.parseExpression();
    this.expect("DO");
    const body = this.parseStatementList("END_WHILE");
    this.expect("END_WHILE");
    this.consume("SEMI");
    return { kind: "while", condition, body, line };
  }
  private parseRepeat(): RepeatNode {
    const line = this.expect("REPEAT").line;
    const body = this.parseStatementList("UNTIL");
    this.expect("UNTIL");
    const until = this.parseExpression();
    this.consume("END_REPEAT");
    this.consume("SEMI");
    return { kind: "repeat", body, until, line };
  }
  private parseStatementList(...terminators: TokenType[]): ASTNode[] {
    const stmts: ASTNode[] = [];
    while (!terminators.includes(this.peek().type) && !this.match("EOF")) {
      const s = this.parseStatement();
      if (s) stmts.push(s);
    }
    return stmts;
  }
  // === Expression parsing (precedence climbing) ===
  private parseExpression(): ASTNode { return this.parseOr(); }
  private parseOr(): ASTNode {
    let left = this.parseXor();
    while (this.match("OR")) { const t = this.advance(); left = { kind: "logical", op: "OR", left, right: this.parseXor(), line: t.line }; }
    return left;
  }
  private parseXor(): ASTNode {
    let left = this.parseAnd();
    while (this.match("XOR")) { const t = this.advance(); left = { kind: "logical", op: "XOR", left, right: this.parseAnd(), line: t.line }; }
    return left;
  }
  private parseAnd(): ASTNode {
    let left = this.parseNot();
    while (this.match("AND", "AMP")) { const t = this.advance(); left = { kind: "logical", op: "AND", left, right: this.parseNot(), line: t.line }; }
    return left;
  }
  private parseNot(): ASTNode {
    if (this.match("NOT")) { const t = this.advance(); return { kind: "unary_op", op: "NOT", operand: this.parseNot(), line: t.line }; }
    return this.parseComparison();
  }
  private parseComparison(): ASTNode {
    let left = this.parseAdd();
    while (this.match("EQ", "NE", "LT", "LE", "GT", "GE")) {
      const t = this.advance();
      left = { kind: "compare", op: t.value, left, right: this.parseAdd(), line: t.line };
    }
    return left;
  }
  private parseAdd(): ASTNode {
    let left = this.parseMul();
    while (this.match("PLUS", "MINUS")) {
      const t = this.advance();
      left = { kind: "binary_op", op: t.value, left, right: this.parseMul(), line: t.line };
    }
    return left;
  }
  private parseMul(): ASTNode {
    let left = this.parsePower();
    while (this.match("STAR", "SLASH", "MOD")) {
      const t = this.advance();
      left = { kind: "binary_op", op: t.type === "MOD" ? "MOD" : t.value, left, right: this.parsePower(), line: t.line };
    }
    return left;
  }
  private parsePower(): ASTNode {
    let left = this.parseUnary();
    if (this.match("POWER")) { const t = this.advance(); left = { kind: "binary_op", op: "**", left, right: this.parseUnary(), line: t.line }; }
    return left;
  }
  private parseUnary(): ASTNode {
    if (this.match("MINUS")) { const t = this.advance(); return { kind: "unary_op", op: "-", operand: this.parseUnary(), line: t.line }; }
    return this.parsePostfix();
  }
  private parsePostfix(): ASTNode {
    let node = this.parseAtom();
    while (true) {
      if (this.match("DOT")) {
        this.advance();
        const next = this.peek();
        if (next.type === "NUMBER") {
          // Bit access: ident.N
          const bit = parseInt(this.advance().value);
          node = { kind: "bit_access", object: node, bit, line: next.line };
        } else if (next.type === "IDENT") {
          node = { kind: "member_access", object: node, member: this.advance().value, line: next.line };
        } else {
          break;
        }
      } else if (this.match("LBRACKET")) {
        this.advance();
        const indices: ASTNode[] = [this.parseExpression()];
        while (this.consume("COMMA")) indices.push(this.parseExpression());
        this.expect("RBRACKET");
        // Handle [i][j] → multiple index nodes
        while (this.match("LBRACKET")) {
          this.advance();
          indices.push(this.parseExpression());
          this.expect("RBRACKET");
        }
        node = { kind: "index", array: node, indices, line: node.line };
      } else if (this.match("LPAREN") && node.kind === "ident") {
        // Function call or FB invoke
        this.advance();
        const name = (node as IdentNode).name;
        // Check if it's FB-style (named args: IN := ...)
        if (this.peek().type === "IDENT" && this.tokens[this.pos + 1]?.type === "ASSIGN") {
          const args: Record<string, ASTNode> = {};
          while (!this.match("RPAREN", "EOF")) {
            const paramName = this.expect("IDENT").value;
            this.expect("ASSIGN");
            args[paramName] = this.parseExpression();
            this.consume("COMMA");
          }
          this.expect("RPAREN");
          node = { kind: "function_call", name, args: [{ kind: "literal", value: JSON.stringify(args), litType: "string", line: node.line }], line: node.line } as any;
          // Actually return as FB invoke
          return { kind: "fb_invoke" as any, instance: name, args, line: node.line } as any;
        }
        // Regular function call
        const args: ASTNode[] = [];
        if (!this.match("RPAREN")) {
          args.push(this.parseExpression());
          while (this.consume("COMMA")) args.push(this.parseExpression());
        }
        this.expect("RPAREN");
        node = { kind: "function_call", name, args, line: node.line };
      } else {
        break;
      }
    }
    return node;
  }
  private parseAtom(): ASTNode {
    const t = this.peek();
    if (t.type === "NUMBER") { this.advance(); return { kind: "literal", value: t.value, litType: "int", line: t.line }; }
    if (t.type === "REAL") { this.advance(); return { kind: "literal", value: t.value, litType: "real", line: t.line }; }
    if (t.type === "STRING") { this.advance(); return { kind: "literal", value: t.value, litType: "string", line: t.line }; }
    if (t.type === "TIME_LITERAL") { this.advance(); return { kind: "literal", value: t.value, litType: "time", line: t.line }; }
    if (t.type === "TRUE" || t.type === "FALSE") { this.advance(); return { kind: "literal", value: t.value, litType: "bool", line: t.line }; }
    if (t.type === "IDENT") { this.advance(); return { kind: "ident", name: t.value, line: t.line }; }
    if (t.type === "LPAREN") {
      this.advance();
      const expr = this.parseExpression();
      this.expect("RPAREN");
      return expr;
    }
    // Fallback: skip unknown tokens
    // Type conversions (DINT_TO_REAL etc.) are handled as function calls via IDENT path
    // Skip unknown tokens
    this.advance();
    return { kind: "literal", value: t.value, litType: "int", line: t.line };
  }
}
export function parseSTSource(source: string): ASTNode[] {
  const tokens = tokenize(source);
  const parser = new Parser(tokens);
  return parser.parse();
}
