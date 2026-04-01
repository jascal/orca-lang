// Decision Table AST Types

export type ConditionType = 'bool' | 'enum' | 'int_range' | 'string';

export interface ConditionDef {
  name: string;
  type: ConditionType;
  values: string[];         // enum values, or ['true','false'] for bool
  range?: { min: number; max: number };  // for int_range
}

export type ActionType = 'bool' | 'enum' | 'string';

export interface ActionOutputDef {
  name: string;
  type: ActionType;
  description?: string;
  values?: string[];        // valid values for enum type
}

export type CellValue =
  | { kind: 'any' }                           // "-" wildcard
  | { kind: 'exact'; value: string }          // exact match
  | { kind: 'negated'; value: string }        // "!value"
  | { kind: 'set'; values: string[] };        // "a,b" (match any in set)

export interface Rule {
  number?: number;           // optional rule # from the # column
  conditions: Map<string, CellValue>;   // condition name → cell value
  actions: Map<string, string>;          // action name → output value
}

export interface DecisionTableDef {
  name: string;
  description?: string;
  conditions: ConditionDef[];
  actions: ActionOutputDef[];
  rules: Rule[];
  policy: 'first-match' | 'all-match';  // default: first-match
}
