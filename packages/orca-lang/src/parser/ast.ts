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
  | 'ON_DONE'
  | 'PROPERTIES'
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

export interface RegionDef {
  name: string;
  states: StateDef[];
}

export type SyncStrategy = 'all-final' | 'any-final' | 'custom';

export interface ParallelDef {
  regions: RegionDef[];
  sync?: SyncStrategy;  // default: 'all-final'
}

export interface InvokeDef {
  machine: string;                    // Name of machine to invoke
  input?: Record<string, string>;     // Optional: ctx.field -> child param mapping
  onDone?: string;                    // Event to emit when child completes
  onError?: string;                   // Event to emit when child errors
}

export interface StateDef {
  name: string;
  description?: string;
  isInitial: boolean;
  isFinal: boolean;
  onEntry?: string;
  onExit?: string;
  onDone?: string;       // target state when parallel sync completes
  timeout?: {
    duration: string;
    target: string;
  };
  invoke?: InvokeDef;     // machine invocation (mutually exclusive with contains/parallel)
  contains?: StateDef[];
  parallel?: ParallelDef;  // mutually exclusive with contains
  parent?: string;  // Parent state name for hierarchical states
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

export interface EffectDef {
  name: string;
  input: string;   // free-form description of input shape
  output: string;  // free-form description of output shape
}

// Property types for bounded model checking

export interface ReachabilityProperty {
  kind: 'reachable' | 'unreachable';
  from: string;
  to: string;
}

export interface PassesThroughProperty {
  kind: 'passes_through';
  from: string;
  to: string;
  through: string;
}

export interface LiveProperty {
  kind: 'live';
}

export interface RespondsProperty {
  kind: 'responds';
  from: string;
  to: string;
  within: number;
}

export interface InvariantProperty {
  kind: 'invariant';
  expression: GuardExpression;
  inState?: string;
}

export type Property =
  | ReachabilityProperty
  | PassesThroughProperty
  | LiveProperty
  | RespondsProperty
  | InvariantProperty;

export interface MachineDef {
  name: string;
  context: ContextField[];
  events: EventDef[];
  states: StateDef[];
  transitions: Transition[];
  guards: GuardDef[];
  actions: ActionSignature[];
  effects?: EffectDef[];     // declared in ## effects section; undefined if section absent
  properties?: Property[];
}

// Multi-machine file (for machine invocation)
export interface OrcaFile {
  machines: MachineDef[];
}

export interface ParseResult {
  file: OrcaFile;
  tokens: Token[];
}
