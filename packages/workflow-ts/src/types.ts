/**
 * Shared types for the workflow-ts package.
 */

export interface PhaseStep {
  id: string;          // "5.1", "5.2", etc.
  title: string;       // Work item title from the implementation table
  dependsOn: string;   // Dependencies (step IDs or "—")
  deliverable: string; // Expected deliverable
  description: string; // Full section text from the phase doc
}

export interface FileChange {
  path: string;
  operation: 'create' | 'overwrite' | 'delete';
  content?: string;  // Required for create/overwrite
}

export interface LLMChangesResponse {
  files: FileChange[];
  commit_message: string;
  explanation: string;
}

export interface LLMContextResponse {
  files: string[];
  reasoning: string;
}

export interface StepResult {
  status: 'done' | 'failed' | 'skipped';
  changes?: FileChange[];
  commitMessage?: string;
  error?: string;
}

export interface OrchestratorOptions {
  phaseFile: string;
  repoRoot: string;
  dryRun?: boolean;
  filterStep?: string;  // Only implement this step ID (e.g., "5.1")
}
