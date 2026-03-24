import { ActionScaffold } from '../skills.js';
import { MachineDef } from '../parser/ast.js';
import { CodeGeneratorType } from '../config/types.js';

export interface CodeGenerator {
  name(): string;
  generate(actions: ActionScaffold[], machine: MachineDef): string;
  generateAction(action: ActionScaffold, machine: MachineDef): string;
}

const generators = new Map<CodeGeneratorType, () => CodeGenerator>();

export function registerCodeGenerator(type: CodeGeneratorType, factory: () => CodeGenerator): void {
  generators.set(type, factory);
}

export function getCodeGenerator(type: CodeGeneratorType): CodeGenerator {
  const factory = generators.get(type);
  if (!factory) {
    throw new Error(`No code generator registered for type: ${type}`);
  }
  return factory();
}

export function listCodeGenerators(): CodeGeneratorType[] {
  return Array.from(generators.keys());
}
