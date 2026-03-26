import { Token, ParseResult, MachineDef, ContextField, EventDef, StateDef, Transition, GuardDef, GuardExpression, ActionSignature, ParallelDef, RegionDef, SyncStrategy } from './ast.js';

export class Parser {
  private tokens: Token[];
  private pos: number = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(offset: number = 0): Token {
    return this.tokens[this.pos + offset] || this.tokens[this.tokens.length - 1];
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: string, value?: string): Token {
    const token = this.advance();
    if (token.type !== type || (value !== undefined && token.value !== value)) {
      throw new Error(`Expected ${type}${value ? ` "${value}"` : ''} at ${token.pos.line}:${token.pos.column}, got ${token.type}${token.value ? ` "${token.value}"` : ''}`);
    }
    return token;
  }

  private match(type: string, value?: string): boolean {
    const tok = this.peek();
    if (tok.type === type && (value === undefined || tok.value === value)) {
      this.advance();
      return true;
    }
    return false;
  }

  // Parse context block: { name: type, name: type = default, ... }
  private parseContext(): ContextField[] {
    const fields: ContextField[] = [];
    this.expect('LBRACE');
    while (!this.match('RBRACE')) {
      const name = this.expect('IDENT').value;
      this.expect('COLON');
      const type = this.parseType();
      let defaultValue: string | undefined;
      if (this.match('EQ')) {
        defaultValue = this.expect('NUMBER').value;
      }
      fields.push({ name, type, defaultValue });
      // Allow trailing comma or just continue
      this.match('COMMA');
    }
    return fields;
  }

  private parseType(): ContextField['type'] {
    const token = this.peek();

    // Handle base types with optional suffix
    const baseType = token.value;
    let isOptional = false;

    switch (baseType) {
      case 'string':
        this.advance();
        isOptional = this.match('QUESTION');
        if (!isOptional && this.match('LBRACKET')) {
          // array type like string[]
          this.expect('RBRACKET');
          return { kind: 'array', elementType: 'string' };
        }
        return isOptional ? { kind: 'optional', innerType: 'string' } : { kind: 'string' };
      case 'int':
        this.advance();
        isOptional = this.match('QUESTION');
        return isOptional ? { kind: 'optional', innerType: 'int' } : { kind: 'int' };
      case 'decimal':
        this.advance();
        isOptional = this.match('QUESTION');
        return isOptional ? { kind: 'optional', innerType: 'decimal' } : { kind: 'decimal' };
      case 'bool':
        this.advance();
        isOptional = this.match('QUESTION');
        return isOptional ? { kind: 'optional', innerType: 'bool' } : { kind: 'bool' };
      case 'map':
        this.advance();
        this.expect('LT');
        const keyType = this.expect('IDENT').value;
        this.expect('COMMA');
        const valueType = this.expect('IDENT').value;
        this.expect('GT');
        return { kind: 'map', keyType, valueType };
      case 'array':
        this.advance();
        return { kind: 'array', elementType: 'string' };
      default:
        this.advance();
        // Check for array suffix
        if (this.match('LBRACKET')) {
          this.expect('RBRACKET');
          return { kind: 'array', elementType: baseType };
        }
        return { kind: 'custom', name: baseType };
    }
  }

  // Parse events block: { event1, event2, event3 }
  private parseEvents(): EventDef[] {
    const events: EventDef[] = [];
    this.expect('LBRACE');
    while (!this.match('RBRACE')) {
      const name = this.expect('IDENT').value;
      events.push({ name });
      // Events are separated by commas OR newlines (implicitly by being in the block)
      // Just try to match comma, if not there we'll loop and check for RBRACE
      if (!this.match('COMMA')) {
        // If next token is RBRACE, we'll exit loop next iteration
        // If next token is another IDENT, that's fine too - we'll process it
      }
    }
    return events;
  }

  private parseStateAnnotations(): { isInitial: boolean; isFinal: boolean } {
    let isInitial = false;
    let isFinal = false;
    while (this.match('LBRACKET')) {
      // Could be IDENT, INITIAL, or FINAL
      const tok = this.advance();
      const ann = tok.value;
      this.expect('RBRACKET');
      if (ann === 'initial') isInitial = true;
      if (ann === 'final') isFinal = true;
    }
    return { isInitial, isFinal };
  }

  private parseStateBody(parentName?: string): Omit<StateDef, 'name' | 'isInitial' | 'isFinal'> {
    const result: Omit<StateDef, 'name' | 'isInitial' | 'isFinal'> = {};
    this.expect('LBRACE');
    while (!this.match('RBRACE')) {
      if (this.match('DESCRIPTION')) {
        this.expect('COLON');
        result.description = this.expect('STRING').value;
      } else if (this.match('ON_ENTRY')) {
        this.expect('COLON');
        this.expect('ARROW');
        result.onEntry = this.expect('IDENT').value;
      } else if (this.match('ON_EXIT')) {
        this.expect('COLON');
        this.expect('ARROW');
        result.onExit = this.expect('IDENT').value;
      } else if (this.match('TIMEOUT')) {
        this.expect('COLON');
        const num = this.expect('NUMBER').value;
        // Handle optional 's' unit suffix
        let duration = num;
        if (this.peek().type === 'IDENT') {
          duration = num + this.advance().value;
        }
        this.expect('ARROW');
        result.timeout = { duration, target: this.expect('IDENT').value };
      } else if (this.match('IGNORE')) {
        this.expect('COLON');
        const event = this.expect('IDENT').value;
        if (!result.ignoredEvents) result.ignoredEvents = [];
        result.ignoredEvents.push(event);
      } else if (this.match('ON_DONE')) {
        this.expect('COLON');
        this.expect('ARROW');
        result.onDone = this.expect('IDENT').value;
      } else if (this.peek().type === 'PARALLEL') {
        if (!parentName) {
          throw new Error(`Unexpected parallel block at top level at ${this.peek().pos.line}:${this.peek().pos.column}`);
        }
        if (result.contains) {
          throw new Error(`State cannot have both nested states and parallel regions at ${this.peek().pos.line}:${this.peek().pos.column}`);
        }
        result.parallel = this.parseParallel(parentName);
      } else if (this.match('STATE')) {
        // Nested state block - parse contains
        // Only parse if we have a parent name (nested inside another state)
        if (parentName) {
          if (result.parallel) {
            throw new Error(`State cannot have both nested states and parallel regions at ${this.peek().pos.line}:${this.peek().pos.column}`);
          }
          this.pos--;  // Back up to parse the nested state properly
          const nestedStates = this.parseStatesRecursive(parentName);
          result.contains = nestedStates;
        } else {
          throw new Error(`Unexpected nested state at top level at ${this.peek().pos.line}:${this.peek().pos.column}`);
        }
      } else {
        throw new Error(`Unexpected token in state body: ${this.peek().type} "${this.peek().value}" at ${this.peek().pos.line}:${this.peek().pos.column}`);
      }
    }
    return result;
  }

  // Parse nested states with parent name set
  private parseStatesRecursive(parentName: string): StateDef[] {
    const states: StateDef[] = [];
    while (this.match('STATE')) {
      const name = this.expect('IDENT').value;
      const { isInitial, isFinal } = this.parseStateAnnotations();
      const body = this.parseStateBody(name);

      // Validate: compound state cannot be final
      if (isFinal && body.contains && body.contains.length > 0) {
        throw new Error(`State "${name}" cannot be both final and contain nested states at ${this.peek(-1).pos.line}:${this.peek(-1).pos.column}`);
      }
      if (isFinal && body.parallel) {
        throw new Error(`State "${name}" cannot be both final and contain parallel regions at ${this.peek(-1).pos.line}:${this.peek(-1).pos.column}`);
      }

      const state: StateDef = { name, isInitial, isFinal, parent: parentName, ...body };
      states.push(state);
    }
    return states;
  }

  private parseParallel(parentName: string): ParallelDef {
    this.expect('PARALLEL');
    let sync: SyncStrategy | undefined;

    // Optional [sync: strategy] annotation
    if (this.match('LBRACKET')) {
      const key = this.expect('IDENT').value;
      if (key !== 'sync') {
        throw new Error(`Expected 'sync' in parallel annotation at ${this.peek().pos.line}:${this.peek().pos.column}, got '${key}'`);
      }
      this.expect('COLON');
      // Sync value may be hyphenated: all-final, any-final, custom
      let syncValue = this.expect('IDENT').value;
      if (this.peek().type === 'IDENT' && (syncValue === 'all' || syncValue === 'any')) {
        // Handle hyphenated values that the lexer doesn't join
        // Actually the lexer treats '-' as part of ident if followed by alpha? Let's check.
        // Safer: accept "all_final", "any_final" as well
      }
      if (syncValue === 'all' || syncValue === 'any') {
        // Expect the rest: e.g., "-final" parsed as separate tokens
        // The '-' is not a token, so we need a different approach.
        // Let's support underscored forms: all_final, any_final, custom
        throw new Error(`Invalid sync value '${syncValue}'. Use all_final, any_final, or custom at ${this.peek().pos.line}:${this.peek().pos.column}`);
      }
      if (syncValue === 'all_final') sync = 'all-final';
      else if (syncValue === 'any_final') sync = 'any-final';
      else if (syncValue === 'custom') sync = 'custom';
      else throw new Error(`Invalid sync strategy '${syncValue}' at ${this.peek().pos.line}:${this.peek().pos.column}. Expected all_final, any_final, or custom`);
      this.expect('RBRACKET');
    }

    this.expect('LBRACE');
    const regions: RegionDef[] = [];

    while (!this.match('RBRACE')) {
      if (!this.match('REGION')) {
        throw new Error(`Expected 'region' inside parallel block at ${this.peek().pos.line}:${this.peek().pos.column}, got ${this.peek().type} "${this.peek().value}"`);
      }
      const regionName = this.expect('IDENT').value;
      this.expect('LBRACE');

      // Parse states inside the region
      const states: StateDef[] = [];
      while (this.peek().type === 'STATE') {
        this.advance(); // consume STATE
        const name = this.expect('IDENT').value;
        const { isInitial, isFinal } = this.parseStateAnnotations();
        const body = this.parseStateBody(name);

        // Disallow nested parallel inside a region (v1 limitation)
        if (body.parallel) {
          throw new Error(`Nested parallel regions are not supported at ${this.peek().pos.line}:${this.peek().pos.column}`);
        }

        const state: StateDef = { name, isInitial, isFinal, parent: `${parentName}.${regionName}`, ...body };
        states.push(state);
      }

      this.expect('RBRACE');
      regions.push({ name: regionName, states });
    }

    if (regions.length === 0) {
      throw new Error(`Parallel block must contain at least one region`);
    }

    return { regions, sync };
  }

  private parseStates(): StateDef[] {
    const states: StateDef[] = [];
    while (this.match('STATE')) {
      const name = this.expect('IDENT').value;
      const { isInitial, isFinal } = this.parseStateAnnotations();
      const body = this.parseStateBody(name);  // Pass name as parent for nested state handling

      // Validate: compound state cannot be final
      if (isFinal && body.contains && body.contains.length > 0) {
        throw new Error(`State "${name}" cannot be both final and contain nested states at ${this.peek(-1).pos.line}:${this.peek(-1).pos.column}`);
      }
      if (isFinal && body.parallel) {
        throw new Error(`State "${name}" cannot be both final and contain parallel regions at ${this.peek(-1).pos.line}:${this.peek(-1).pos.column}`);
      }

      const state: StateDef = { name, isInitial, isFinal, ...body };
      states.push(state);
    }
    return states;
  }

  private parseGuardExpression(): GuardExpression {
    return this.parseGuardOr();
  }

  private parseGuardOr(): GuardExpression {
    let left = this.parseGuardAnd();
    while (this.match('OR') || (this.peek().type === 'IDENT' && this.peek().value === 'or')) {
      if (this.peek(-1).type === 'IDENT') this.advance();
      const right = this.parseGuardAnd();
      left = { kind: 'or', left, right };
    }
    return left;
  }

  private parseGuardAnd(): GuardExpression {
    let left = this.parseGuardNot();
    while (this.match('AND') || (this.peek().type === 'IDENT' && this.peek().value === 'and')) {
      if (this.peek(-1).type === 'IDENT') this.advance();
      const right = this.parseGuardNot();
      left = { kind: 'and', left, right };
    }
    return left;
  }

  private parseGuardNot(): GuardExpression {
    if (this.match('NOT') || (this.peek().type === 'IDENT' && this.peek().value === 'not')) {
      if (this.peek(-1).type === 'IDENT') this.advance();
      return { kind: 'not', expr: this.parseGuardPrimary() };
    }
    return this.parseGuardPrimary();
  }

  private parseGuardPrimary(): GuardExpression {
    const token = this.peek();

    // Handle parentheses first
    if (this.match('LPAREN')) {
      const expr = this.parseGuardExpression();
      this.expect('RPAREN');
      return expr;
    }

    // Handle true/false literals
    if (this.match('IDENT')) {
      if (token.value === 'true') return { kind: 'true' };
      if (token.value === 'false') return { kind: 'false' };

      // It's a variable path - push back and parse comparison
      this.pos--;
    }

    // Parse variable path
    const varPath = this.parseVariablePath();

    // Check for comparison operator
    const op = this.peek();
    if (op.type === 'LT' || op.type === 'GT' || op.type === 'LE' || op.type === 'GE') {
      this.advance();
      const cmpOp = this.mapComparisonOp(op.type);
      const value = this.parseValueRef();
      return { kind: 'compare', op: cmpOp, left: varPath, right: value };
    }
    if (op.type === 'EQ' || (op.type === 'IDENT' && (op.value === '==' || op.value === '='))) {
      this.advance();
      const value = this.parseValueRef();
      return { kind: 'compare', op: 'eq', left: varPath, right: value };
    }
    if (op.type === 'NE' || (op.type === 'IDENT' && op.value === '!=')) {
      this.advance();
      const value = this.parseValueRef();
      return { kind: 'compare', op: 'ne', left: varPath, right: value };
    }

    // Just a variable reference (treated as truthy check)
    return { kind: 'nullcheck', expr: varPath, isNull: false };
  }

  private parseVariablePath(): { kind: 'variable'; path: string[] } {
    const parts: string[] = [];
    while (true) {
      const tok = this.expect('IDENT');
      parts.push(tok.value);
      if (!this.match('DOT')) break;
    }
    return { kind: 'variable', path: parts };
  }

  private parseValueRef(): { kind: 'value'; type: 'string' | 'number' | 'boolean' | 'null'; value: string | number | boolean | null } {
    const tok = this.peek();
    if (tok.type === 'NUMBER') {
      this.advance();
      return { kind: 'value', type: 'number', value: parseFloat(tok.value) };
    }
    if (tok.type === 'STRING') {
      this.advance();
      return { kind: 'value', type: 'string', value: tok.value };
    }
    if (tok.type === 'IDENT') {
      this.advance();
      if (tok.value === 'null') {
        return { kind: 'value', type: 'null', value: null };
      }
      if (tok.value === 'true') {
        return { kind: 'value', type: 'boolean', value: true };
      }
      if (tok.value === 'false') {
        return { kind: 'value', type: 'boolean', value: false };
      }
      // Unknown identifier - treat as variable
      return { kind: 'value', type: 'null', value: tok.value };
    }
    // Default
    return { kind: 'value', type: 'null', value: null };
  }

  private mapComparisonOp(type: string): 'eq' | 'ne' | 'lt' | 'gt' | 'le' | 'ge' {
    switch (type) {
      case 'LT': return 'lt';
      case 'GT': return 'gt';
      case 'LE': return 'le';
      case 'GE': return 'ge';
      case 'EQ': return 'eq';
      case 'NE': return 'ne';
      default: return 'ne';
    }
  }

  private parseGuardDefinitions(): GuardDef[] {
    const guards: GuardDef[] = [];
    this.expect('LBRACE');
    while (!this.match('RBRACE')) {
      const name = this.expect('IDENT').value;
      this.expect('COLON');
      const expression = this.parseGuardExpression();
      guards.push({ name, expression });
      this.match('COMMA');
    }
    return guards;
  }

  private parseTransition(): Transition {
    const source = this.expect('IDENT').value;
    this.expect('PLUS');
    const event = this.expect('IDENT').value;
    let guard: Transition['guard'];
    if (this.match('LBRACKET')) {
      const negated = this.match('NOT');
      const name = this.expect('IDENT').value;
      this.expect('RBRACKET');
      guard = { name, negated };
    }
    this.expect('ARROW');
    const target = this.expect('IDENT').value;
    let action: string | undefined;
    if (this.match('COLON')) {
      const actionToken = this.expect('IDENT');
      if (actionToken.value !== '_') action = actionToken.value;
    }
    return { source, event, guard, target, action };
  }

  private parseTransitions(): Transition[] {
    const transitions: Transition[] = [];
    this.expect('LBRACE');
    while (!this.match('RBRACE')) {
      transitions.push(this.parseTransition());
      this.match('COMMA');
    }
    return transitions;
  }

  private parseActionSignatures(): ActionSignature[] {
    const actions: ActionSignature[] = [];
    this.expect('LBRACE');
    while (!this.match('RBRACE')) {
      const name = this.expect('IDENT').value;
      this.expect('COLON');
      const params: string[] = [];
      this.expect('LPAREN');
      // Parameters: name : Type, name : Type, ...
      while (!this.match('RPAREN')) {
        const paramName = this.expect('IDENT').value;
        params.push(paramName);
        // Skip optional : Type
        if (this.match('COLON')) {
          // Skip the type identifier
          this.expect('IDENT');
        }
        // Handle comma between parameters
        if (this.match('COMMA')) {
          // Continue to next parameter
        }
      }
      this.expect('ARROW');
      let returnType = '';
      let hasEffect = false;
      let effectType: string | undefined;

      // Parse return type(s) - could be "Context" or "Context + Effect<T>"
      const firstIdent = this.expect('IDENT').value;

      // Check for + Effect<...>
      if (this.match('PLUS')) {
        const effectIdent = this.expect('IDENT').value;
        // Handle Effect<T> where T might be compound
        if (effectIdent === 'Effect') {
          this.expect('LT');
          const innerType = this.expect('IDENT').value;
          this.expect('GT');
          hasEffect = true;
          effectType = innerType;
          returnType = 'Context';
        } else if (effectIdent.startsWith('Effect<')) {
          hasEffect = true;
          effectType = effectIdent.match(/Effect<(.+)>/)?.[1];
          returnType = 'Context';
        } else {
          returnType = firstIdent;
        }
      } else {
        returnType = firstIdent;
      }

      actions.push({ name, parameters: params, returnType, hasEffect, effectType });
      // Optional comma between actions
      this.match('COMMA');
    }
    return actions;
  }

  parse(): ParseResult {
    this.expect('MACHINE');
    const name = this.expect('IDENT').value;

    let context: ContextField[] = [];
    let events: EventDef[] = [];
    let states: StateDef[] = [];
    let transitions: Transition[] = [];
    let guards: GuardDef[] = [];
    let actions: ActionSignature[] = [];

    while (this.peek().type !== 'EOF') {
      if (this.match('CONTEXT')) {
        context = this.parseContext();
      } else if (this.match('EVENTS')) {
        events = this.parseEvents();
      } else if (this.match('STATE')) {
        this.pos--;
        states = this.parseStates();
      } else if (this.match('TRANSITIONS')) {
        transitions = this.parseTransitions();
      } else if (this.match('GUARDS')) {
        guards = this.parseGuardDefinitions();
      } else if (this.match('ACTIONS')) {
        actions = this.parseActionSignatures();
      } else {
        throw new Error(`Unexpected token: ${this.peek().type} "${this.peek().value}" at ${this.peek().pos.line}:${this.peek().pos.column}`);
      }
    }

    this.expect('EOF');

    return {
      machine: { name, context, events, states, transitions, guards, actions },
      tokens: this.tokens,
    };
  }
}

export function parse(tokens: Token[]): ParseResult {
  return new Parser(tokens).parse();
}
