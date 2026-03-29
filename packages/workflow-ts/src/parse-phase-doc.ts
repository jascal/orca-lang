/**
 * Parses an Orca phase document to extract implementation steps.
 *
 * Reads the "Implementation Order" or "Suggested step sequence" table and
 * enriches each step with the description text from the corresponding
 * track section.
 */

import type { PhaseStep } from './types.js';

/**
 * Parse all steps from a phase document markdown string.
 */
export function parsePhaseDoc(source: string): PhaseStep[] {
  const steps = parseStepsTable(source);
  const sections = extractSections(source);

  return steps.map(step => ({
    ...step,
    description: findStepDescription(step, sections),
  }));
}

interface RawStep {
  id: string;
  title: string;
  dependsOn: string;
  deliverable: string;
  description: string;
}

function parseStepsTable(source: string): RawStep[] {
  const lines = source.split('\n');
  const steps: RawStep[] = [];
  let inTable = false;
  let headerParsed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Look for the implementation steps table (has Step | Work item | Depends | Deliverable columns)
    if (
      !inTable &&
      line.startsWith('|') &&
      /step/i.test(line) &&
      /work.?item/i.test(line)
    ) {
      inTable = true;
      headerParsed = false;
      continue;
    }

    if (inTable) {
      // Skip separator line
      if (/^\|[-| ]+\|$/.test(line)) {
        headerParsed = true;
        continue;
      }

      // Empty line or non-table line ends the table
      if (!line.startsWith('|')) {
        inTable = false;
        continue;
      }

      if (!headerParsed) continue;

      const cells = line
        .split('|')
        .slice(1, -1)
        .map(c => c.trim());

      if (cells.length >= 3) {
        const [id, title, dependsOn, deliverable = ''] = cells;
        if (id && id !== 'Step' && /^\d/.test(id)) {
          steps.push({
            id: id.replace(/`/g, '').trim(),
            title: cleanMarkdown(title),
            dependsOn: cleanMarkdown(dependsOn),
            deliverable: cleanMarkdown(deliverable),
            description: '',
          });
        }
      }
    }
  }

  return steps;
}

/**
 * Extract all named sections from the document.
 * Returns a map of section title -> section body text.
 */
function extractSections(source: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = source.split('\n');
  let currentTitle = '';
  let currentBody: string[] = [];

  for (const line of lines) {
    const h3Match = line.match(/^### (.+)$/);
    const h2Match = line.match(/^## (.+)$/);

    if (h3Match || h2Match) {
      if (currentTitle && currentBody.length > 0) {
        sections.set(currentTitle.toLowerCase(), currentBody.join('\n').trim());
      }
      currentTitle = (h3Match?.[1] ?? h2Match?.[1] ?? '').trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }

  if (currentTitle && currentBody.length > 0) {
    sections.set(currentTitle.toLowerCase(), currentBody.join('\n').trim());
  }

  return sections;
}

/**
 * Find the description for a step by matching its title against section headings.
 * The work item title typically contains a code like "A1", "B2", "C3" that
 * corresponds to a section header like "### A1: Fix Go module path".
 */
function findStepDescription(step: RawStep, sections: Map<string, string>): string {
  // Extract the track code from the title (e.g., "A1", "B2", "C1")
  const codeMatch = step.title.match(/^([A-Z]\d+)/);
  if (!codeMatch) {
    return step.title;
  }
  const code = codeMatch[1].toLowerCase();

  // Look for a section that starts with this code
  for (const [title, body] of sections) {
    if (title.startsWith(code + ':') || title.startsWith(code + ' ')) {
      return `**${title}**\n\n${body}`;
    }
  }

  // Fallback: use the title
  return step.title;
}

function cleanMarkdown(s: string): string {
  return s.replace(/`/g, '').trim();
}
