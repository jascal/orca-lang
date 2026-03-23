// Orca AST Type Definitions

export interface Position {
  line: number;
  column: number;
  offset: number;
}

export interface Token {
  type: TokenType;
  value: string;
  pos: Position;
}

export type TokenType =
  | 'IDENT'
  | 'STRING'
  | 'NUMBER'
  | 'LBRACE'
  | 'RBRACE'
  | 'LBRACKET'
  | 'RBRACKET'
  | 'LPAREN'
  | 'RPAREN'
  | 'PLUS'
  | 'ARROW'
  | 'COLON'
  | 'COMMA'
  | 'PIPE'
  | 'QUESTION'
  | 'EQ'
  | 'NE'
  | 'LT'
  | 'GT'
  | 'LE'
  | 'GE'
  | 'AND'
  | 'OR'
  | 'NOT'
  | 'DOT'
  | 'ON_ENTRY'
  | 'ON_EXIT'
  | 'TIMEOUT'
  | 'IGNORE'
  | 'MACHINE'
  | 'CONTEXT'
  | 'EVENTS'
  | 'STATE'
  | 'TRANSITIONS'
  | 'GUARDS'
  | 'ACTIONS'
  | 'INITIAL'
  | 'FINAL'
  | 'DESCRIPTION'
  | 'CONTAINS'
  | 'PARALLEL'
  | 'REGION'
  | 'EOF'
  | 'UNKNOWN';

export interface ContextField {
  name: string;
  type: Type;
  defaultValue?: string;
}

export type Type =
  | { kind: 'string' }
  | { kind: 'int' }
  | { kind: 'decimal' }
  | { kind: 'bool' }
  | { kind: 'array'; elementType: string }
  | { kind: 'map'; keyType: string; valueType: string }
  | { kind: 'optional'; innerType: string }
  | { kind: 'custom'; name: string };

export interface EventDef {
  name: string;
  payload?: ContextField[];
}

export interface StateDef {
  name: string;
  description?: string;
  isInitial: boolean;
  isFinal: boolean;
  onEntry?: string;
  onExit?: string;
  timeout?: {
    duration: string;
    target: string;
  };
  contains?: StateDef[];
  transitions?: Transition[];
  ignoredEvents?: string[];
}

export interface Transition {
  source: string;
  event: string;
  guard?: GuardRef;
  target: string;
  action?: string;
}

export interface GuardRef {
  name: string;
  negated: boolean;
}

export interface GuardDef {
  name: string;
  expression: GuardExpression;
}

export type GuardExpression =
  | { kind: 'true' }
  | { kind: 'false' }
  | { kind: 'not'; expr: GuardExpression }
  | { kind: 'and'; left: GuardExpression; right: GuardExpression }
  | { kind: 'or'; left: GuardExpression; right: GuardExpression }
  | { kind: 'compare'; op: ComparisonOp; left: VariableRef; right: ValueRef }
  | { kind: 'nullcheck'; expr: VariableRef; isNull: boolean };

export type ComparisonOp = 'eq' | 'ne' | 'lt' | 'gt' | 'le' | 'ge';

export interface VariableRef {
  kind: 'variable';
  path: string[];
}

export interface ValueRef {
  kind: 'value';
  type: 'string' | 'number' | 'boolean' | 'null';
  value: string | number | boolean | null;
}

export interface ActionSignature {
  name: string;
  parameters: string[];
  returnType: string;
  hasEffect: boolean;
  effectType?: string;
}

export interface MachineDef {
  name: string;
  context: ContextField[];
  events: EventDef[];
  states: StateDef[];
  transitions: Transition[];
  guards: GuardDef[];
  actions: ActionSignature[];
}

export interface ParseResult {
  machine: MachineDef;
  tokens: Token[];
}
