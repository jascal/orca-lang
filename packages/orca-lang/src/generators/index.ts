export type { CodeGenerator } from './registry.js';
export { registerCodeGenerator, getCodeGenerator, listCodeGenerators } from './registry.js';
export { TypeScriptCodeGenerator } from './typescript.js';

// Import to register generators
import './typescript.js';
