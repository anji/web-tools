import { isObject, byteLength, toolName } from './extract.js';

/**
 * Measures what a tool set costs to send.
 *
 * Reported in bytes and share, never tokens. Claude token counts are
 * model-specific and only exact from the count_tokens endpoint, and a local
 * tokenizer would be wrong by enough to matter. The actionable answer here is
 * a ranking — which tools to trim first — and bytes give that exactly.
 */

export interface ToolCost {
  name: string;
  bytes: number;
  /** Fraction of the whole payload, 0-1. */
  share: number;
  descriptionBytes: number;
  schemaBytes: number;
  propertyCount: number;
  maxDepth: number;
}

export interface DuplicatedField {
  field: string;
  toolCount: number;
  /** Total bytes this field's definition occupies across every tool. */
  bytes: number;
  /** True when the definition is byte-identical everywhere it appears. */
  identical: boolean;
}

export interface BudgetFinding {
  severity: 'high' | 'medium' | 'info';
  title: string;
  detail: string;
}

export interface BudgetAnalysis {
  totalBytes: number;
  tools: ToolCost[];
  duplicates: DuplicatedField[];
  findings: BudgetFinding[];
}

function schemaDepth(value: unknown, depth = 1): number {
  if (!isObject(value)) return depth;
  let deepest = depth;
  const properties = value['properties'];
  if (isObject(properties)) {
    for (const child of Object.values(properties)) {
      deepest = Math.max(deepest, schemaDepth(child, depth + 1));
    }
  }
  if (isObject(value['items'])) deepest = Math.max(deepest, schemaDepth(value['items'], depth + 1));
  return deepest;
}

const LONG_DESCRIPTION = 600;
const DEEP_NESTING = 4;
const BIG_ENUM = 20;

export function analyseBudget(tools: readonly unknown[]): BudgetAnalysis {
  const totalBytes = byteLength(tools);
  const costs: ToolCost[] = [];
  const findings: BudgetFinding[] = [];

  // field name -> the serialised definition seen in each tool
  const fieldOccurrences = new Map<string, string[]>();
  const descriptions = new Map<string, string[]>();

  for (const [index, tool] of tools.entries()) {
    const name = toolName(tool, index);
    const bytes = byteLength(tool);
    const description = isObject(tool) && typeof tool['description'] === 'string' ? tool['description'] : '';
    const schema = isObject(tool) ? tool['input_schema'] : undefined;
    const properties = isObject(schema) ? schema['properties'] : undefined;

    if (description.length > 0) {
      const seen = descriptions.get(description) ?? [];
      seen.push(name);
      descriptions.set(description, seen);
    }

    if (isObject(properties)) {
      for (const [field, definition] of Object.entries(properties)) {
        const serialised = JSON.stringify(definition) ?? '';
        const seen = fieldOccurrences.get(field) ?? [];
        seen.push(serialised);
        fieldOccurrences.set(field, seen);
      }
    }

    costs.push({
      name,
      bytes,
      share: totalBytes > 0 ? bytes / totalBytes : 0,
      descriptionBytes: byteLength(description),
      schemaBytes: schema === undefined ? 0 : byteLength(schema),
      propertyCount: isObject(properties) ? Object.keys(properties).length : 0,
      maxDepth: schema === undefined ? 0 : schemaDepth(schema),
    });

    if (byteLength(description) > LONG_DESCRIPTION) {
      findings.push({
        severity: 'info',
        title: `${name} has a ${byteLength(description)}-byte description`,
        detail:
          'Long descriptions are often the right call — they are what makes a tool get called correctly. Worth checking only that the length is doing work, rather than repeating the schema in prose.',
      });
    }
    const depth = schema === undefined ? 0 : schemaDepth(schema);
    if (depth > DEEP_NESTING) {
      findings.push({
        severity: 'medium',
        title: `${name} nests ${depth} levels deep`,
        detail:
          'Deeply nested argument objects cost proportionally more to describe and are harder for a model to fill correctly. A flatter shape usually reads better on both counts.',
      });
    }
    if (isObject(properties)) {
      for (const [field, definition] of Object.entries(properties)) {
        if (isObject(definition) && Array.isArray(definition['enum']) && definition['enum'].length > BIG_ENUM) {
          findings.push({
            severity: 'medium',
            title: `${name}.${field} enumerates ${definition['enum'].length} values`,
            detail:
              'Large enums are pure payload on every request. If the set is stable and long, describing the format and validating server-side is usually cheaper than listing every option.',
          });
        }
      }
    }
  }

  costs.sort((a, b) => b.bytes - a.bytes);

  // The redundancy SEP-1576 measured: the same field re-described in tool after
  // tool. Shared fields are the single biggest source of avoidable payload.
  const duplicates: DuplicatedField[] = [];
  for (const [field, occurrences] of fieldOccurrences) {
    if (occurrences.length < 2) continue;
    duplicates.push({
      field,
      toolCount: occurrences.length,
      bytes: occurrences.reduce((sum, s) => sum + byteLength(s), 0),
      identical: new Set(occurrences).size === 1,
    });
  }
  duplicates.sort((a, b) => b.bytes - a.bytes);

  const duplicateBytes = duplicates.reduce((sum, d) => sum + d.bytes, 0);
  if (duplicates.length > 0 && totalBytes > 0) {
    const share = Math.round((duplicateBytes / totalBytes) * 100);
    if (share >= 15) {
      findings.unshift({
        severity: 'high',
        title: `Repeated fields are ${share}% of the payload`,
        detail: `${duplicates.length} field name${duplicates.length === 1 ? '' : 's'} appear in more than one tool. Fields shared across many tools are the largest avoidable cost in most tool sets — the same definition re-sent once per tool, every request.`,
      });
    }
  }

  for (const [description, names] of descriptions) {
    if (names.length > 1) {
      findings.push({
        severity: 'high',
        title: `${names.length} tools share an identical description`,
        detail: `${names.join(', ')} describe themselves the same way. The model chooses between tools almost entirely on their descriptions, so identical text makes the choice arbitrary.`,
      });
      void description;
    }
  }

  // Concentration: how much of the payload the worst offenders account for.
  if (costs.length >= 4) {
    const topCount = Math.max(1, Math.ceil(costs.length * 0.2));
    const topShare = costs.slice(0, topCount).reduce((sum, c) => sum + c.share, 0);
    if (topShare > 0.5) {
      findings.unshift({
        severity: 'info',
        title: `The largest ${topCount} of ${costs.length} tools are ${Math.round(topShare * 100)}% of the payload`,
        detail: 'Trimming concentrates well here — a small number of definitions carry most of the cost.',
      });
    }
  }

  const order = { high: 0, medium: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return { totalBytes, tools: costs, duplicates, findings };
}

const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

export function renderBudget(analysis: BudgetAnalysis, showAll: boolean): string {
  const lines: string[] = [
    `${analysis.tools.length} tools   ${formatBytes(analysis.totalBytes)} of JSON on every request`,
    '',
  ];

  if (analysis.findings.length > 0) {
    for (const finding of analysis.findings) {
      lines.push(`[${finding.severity.toUpperCase()}] ${finding.title}`);
      lines.push(`  ${finding.detail}`);
      lines.push('');
    }
  }

  const shown = showAll ? analysis.tools : analysis.tools.slice(0, 15);
  const width = Math.max(...shown.map((t) => t.name.length), 4);
  lines.push('BY SIZE');
  for (const tool of shown) {
    const percent = `${(tool.share * 100).toFixed(1)}%`.padStart(6);
    lines.push(
      `  ${tool.name.padEnd(width)}  ${formatBytes(tool.bytes).padStart(8)}  ${percent}   ` +
        `${tool.propertyCount} field${tool.propertyCount === 1 ? '' : 's'}, depth ${tool.maxDepth}`,
    );
  }
  if (!showAll && analysis.tools.length > shown.length) {
    lines.push(`  … ${analysis.tools.length - shown.length} more`);
  }
  lines.push('');

  if (analysis.duplicates.length > 0) {
    lines.push('REPEATED FIELDS');
    const fieldWidth = Math.max(...analysis.duplicates.slice(0, 15).map((d) => d.field.length), 5);
    for (const duplicate of analysis.duplicates.slice(0, 15)) {
      lines.push(
        `  ${duplicate.field.padEnd(fieldWidth)}  in ${String(duplicate.toolCount).padStart(3)} tools  ` +
          `${formatBytes(duplicate.bytes).padStart(8)}${duplicate.identical ? '   identical everywhere' : '   definitions differ'}`,
      );
    }
    lines.push('');
  }

  lines.push(
    'Sizes are bytes of JSON, not tokens. Token counts are model-specific and only',
    'exact from a count_tokens endpoint — but the ranking is what you act on, and',
    'bytes give that exactly.',
  );

  return lines.join('\n') + '\n';
}
