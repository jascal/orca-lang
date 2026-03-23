import { Token, TokenType, Position } from './ast.js';

const KEYWORDS: Record<string, TokenType> = {
  machine: 'MACHINE',
  context: 'CONTEXT',
  events: 'EVENTS',
  state: 'STATE',
  transitions: 'TRANSITIONS',
  guards: 'GUARDS',
  actions: 'ACTIONS',
  initial: 'INITIAL',
  final: 'FINAL',
  description: 'DESCRIPTION',
  on_entry: 'ON_ENTRY',
  on_exit: 'ON_EXIT',
  timeout: 'TIMEOUT',
  ignore: 'IGNORE',
  contains: 'CONTAINS',
  parallel: 'PARALLEL',
  region: 'REGION',
};

const OPERATORS: Record<string, TokenType> = {
  '->': 'ARROW',
  '+': 'PLUS',
  ':': 'COLON',
  ',': 'COMMA',
  '[': 'LBRACKET',
  ']': 'RBRACKET',
  '{': 'LBRACE',
  '}': 'RBRACE',
  '(': 'LPAREN',
  ')': 'RPAREN',
  '.': 'DOT',
  '?': 'QUESTION',
  '=': 'EQ',
  '!=': 'NE',
  '<': 'LT',
  '>': 'GT',
  '<=': 'LE',
  '>=': 'GE',
  '!': 'NOT',
  '&&': 'AND',
  '||': 'OR',
};

export class Lexer {
  private source: string;
  private pos: number = 0;
  private line: number = 1;
  private column: number = 1;
  private offset: number = 0;

  constructor(source: string) {
    this.source = source;
  }

  private getPosition(): Position {
    return { line: this.line, column: this.column, offset: this.offset };
  }

  private peek(offset: number = 0): string {
    return this.source[this.pos + offset] || '';
  }

  private advance(): string {
    const char = this.source[this.pos++];
    if (char === '\n') {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    this.offset++;
    return char;
  }

  private skipWhitespace(): void {
    while (this.pos < this.source.length && /\s/.test(this.peek())) {
      this.advance();
    }
  }

  private skipComment(): void {
    if (this.peek() === '#') {
      while (this.pos < this.source.length && this.peek() !== '\n') {
        this.advance();
      }
    }
  }

  private readString(): string {
    const quote = this.advance();
    let value = '';
    while (this.pos < this.source.length && this.peek() !== quote) {
      if (this.peek() === '\\' && this.peek(1) === quote) {
        this.advance();
      }
      value += this.advance();
    }
    if (this.peek() === quote) this.advance();
    return value;
  }

  private readNumber(): string {
    let num = '';
    while (this.pos < this.source.length && /[0-9.]/.test(this.peek())) {
      num += this.advance();
    }
    return num;
  }

  private readIdentifier(): string {
    let ident = '';
    while (this.pos < this.source.length && /[a-zA-Z0-9_]/.test(this.peek())) {
      ident += this.advance();
    }
    return ident;
  }

  private matchOperator(): TokenType | null {
    for (const op of Object.keys(OPERATORS).sort((a, b) => b.length - a.length)) {
      let match = true;
      for (let i = 0; i < op.length; i++) {
        if (this.peek(i) !== op[i]) {
          match = false;
          break;
        }
      }
      if (match) {
        for (let i = 0; i < op.length; i++) this.advance();
        return OPERATORS[op];
      }
    }
    return null;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];

    while (this.pos < this.source.length) {
      this.skipWhitespace();
      this.skipComment();
      if (this.pos >= this.source.length) break;

      const start = this.getPosition();
      const char = this.peek();

      // String
      if (char === '"' || char === "'") {
        const value = this.readString();
        tokens.push({ type: 'STRING', value, pos: start });
        continue;
      }

      // Number
      if (/[0-9]/.test(char)) {
        const value = this.readNumber();
        tokens.push({ type: 'NUMBER', value, pos: start });
        continue;
      }

      // Operator (check multi-char first)
      const opToken = this.matchOperator();
      if (opToken) {
        tokens.push({ type: opToken, value: '', pos: start });
        continue;
      }

      // Identifier or keyword
      if (/[a-zA-Z_]/.test(char)) {
        const value = this.readIdentifier();
        const type = KEYWORDS[value] || 'IDENT';
        tokens.push({ type, value, pos: start });
        continue;
      }

      // Unknown character
      tokens.push({ type: 'UNKNOWN', value: char, pos: start });
      this.advance();
    }

    tokens.push({ type: 'EOF', value: '', pos: this.getPosition() });
    return tokens;
  }
}

export function tokenize(source: string): Token[] {
  return new Lexer(source).tokenize();
}
