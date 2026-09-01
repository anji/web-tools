import { isObject, toolName } from './extract.js';

/**
 * Compares two versions of a tool set.
 *
 * The three-way split is the point. A signature change breaks callers and is
 * easy to see. A *description* change breaks nothing and compiles fine — and
 * changes which tool the model reaches for, and with what arguments. Nothing
 * in a line diff distinguishes those, which is why drift goes unnoticed until
 * an agent starts confidently doing the wrong thing.
 */

export type ChangeKind = 'breaking' | 'behavioral' | 'additive';

export interface SchemaChange {
  kind: ChangeKind;
  tool: string;
  title: string;
  detail: string;
  before?: string;
  after?: string;
}

export interface SchemaDiff {
  changes: SchemaChange[];
  counts: Record<ChangeKind, number>;
  toolsBefore: number;
  toolsAfter: number;
}

const properties = (tool: unknown): Record<string, unknown> => {
  const schema = isObject(tool) ? tool['input_schema'] : undefined;
  const props = isObject(schema) ? schema['properties'] : undefined;
  return isObject(props) ? props : {};
};

const requiredSet = (tool: unknown): Set<string> => {
  const schema = isObject(tool) ? tool['input_schema'] : undefined;
  const required = isObject(schema) ? schema['required'] : undefined;
  return new Set(Array.isArray(required) ? required.filter((r): r is string => typeof r === 'string') : []);
};

const describe = (value: unknown): string | undefined =>
  isObject(value) && typeof value['description'] === 'string' ? value['description'] : undefined;

const typeOf = (value: unknown): string | undefined => {
  if (!isObject(value)) return undefined;
  const type = value['type'];
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.filter((t) => typeof t === 'string').sort().join('|');
  return undefined;
};

const enumOf = (value: unknown): string[] | undefined => {
  if (!isObject(value) || !Array.isArray(value['enum'])) return undefined;
  return value['enum'].map((v) => JSON.stringify(v));
};

const truncate = (text: string): string => (text.length > 90 ? text.slice(0, 87) + '…' : text);

function indexByName(tools: readonly unknown[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const [index, tool] of tools.entries()) map.set(toolName(tool, index), tool);
  return map;
}

export function diffToolSchemas(before: readonly unknown[], after: readonly unknown[]): SchemaDiff {
  const changes: SchemaChange[] = [];
  const beforeMap = indexByName(before);
  const afterMap = indexByName(after);

  const add = (
    kind: ChangeKind,
    tool: string,
    title: string,
    detail: string,
    was?: string,
    now?: string,
  ): void => {
    changes.push({
      kind,
      tool,
      title,
      detail,
      ...(was !== undefined ? { before: was } : {}),
      ...(now !== undefined ? { after: now } : {}),
    });
  };

  for (const name of [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort()) {
    const oldTool = beforeMap.get(name);
    const newTool = afterMap.get(name);

    if (oldTool === undefined) {
      add('additive', name, 'Tool added', 'New capability. Existing callers are unaffected.');
      continue;
    }
    if (newTool === undefined) {
      add(
        'breaking',
        name,
        'Tool removed',
        'Any agent that learned to call this will keep trying. The model has no way to know it is gone until the call fails.',
      );
      continue;
    }

    // --- Description: the change that alters behaviour without breaking anything
    const oldDescription = describe(oldTool);
    const newDescription = describe(newTool);
    if (oldDescription !== newDescription) {
      add(
        'behavioral',
        name,
        'Description changed',
        'The description is what the model uses to decide whether to call this tool at all. Nothing breaks, and the tool may now be chosen in different situations than before.',
        oldDescription === undefined ? '(none)' : truncate(oldDescription),
        newDescription === undefined ? '(none)' : truncate(newDescription),
      );
    }

    if (oldTool !== undefined && newTool !== undefined) {
      const oldStrict = isObject(oldTool) && oldTool['strict'] === true;
      const newStrict = isObject(newTool) && newTool['strict'] === true;
      if (!oldStrict && newStrict) {
        add(
          'breaking',
          name,
          'strict mode enabled',
          'Arguments now have to validate exactly. Anything the model was sending that the schema did not describe will be rejected.',
        );
      } else if (oldStrict && !newStrict) {
        add('additive', name, 'strict mode disabled', 'Validation is looser than before.');
      }
    }

    // --- Properties
    const oldProps = properties(oldTool);
    const newProps = properties(newTool);
    const oldRequired = requiredSet(oldTool);
    const newRequired = requiredSet(newTool);

    for (const field of [...new Set([...Object.keys(oldProps), ...Object.keys(newProps)])].sort()) {
      const oldField = oldProps[field];
      const newField = newProps[field];
      const label = `${name}.${field}`;

      if (oldField === undefined) {
        if (newRequired.has(field)) {
          add(
            'breaking',
            name,
            `Required argument added: ${field}`,
            'Every existing call omits this, so every existing call now fails validation.',
          );
        } else {
          add('additive', name, `Optional argument added: ${field}`, 'Existing calls remain valid.');
        }
        continue;
      }
      if (newField === undefined) {
        add(
          'breaking',
          name,
          `Argument removed: ${field}`,
          'Calls that send it will be rejected, or the value will be silently ignored.',
        );
        continue;
      }

      const oldType = typeOf(oldField);
      const newType = typeOf(newField);
      if (oldType !== newType) {
        add(
          'breaking',
          name,
          `Type changed: ${field}`,
          'A value the model was producing for this argument may no longer be accepted.',
          oldType ?? '(unset)',
          newType ?? '(unset)',
        );
      }

      const oldEnum = enumOf(oldField);
      const newEnum = enumOf(newField);
      if (oldEnum && newEnum) {
        const removed = oldEnum.filter((v) => !newEnum.includes(v));
        const added = newEnum.filter((v) => !oldEnum.includes(v));
        if (removed.length > 0) {
          add(
            'breaking',
            name,
            `Allowed values removed from ${field}`,
            `No longer accepted: ${removed.join(', ')}. A model that learned these will keep offering them.`,
          );
        }
        if (added.length > 0) {
          add('additive', name, `Allowed values added to ${field}`, `Now also accepted: ${added.join(', ')}.`);
        }
      } else if (oldEnum && !newEnum) {
        add('additive', name, `${field} no longer restricted to a fixed set`, 'The enum was removed, so more values are accepted.');
      } else if (!oldEnum && newEnum) {
        add(
          'breaking',
          name,
          `${field} restricted to a fixed set`,
          `Only these are now accepted: ${newEnum.join(', ')}.`,
        );
      }

      const oldFieldDescription = describe(oldField);
      const newFieldDescription = describe(newField);
      if (oldFieldDescription !== newFieldDescription) {
        add(
          'behavioral',
          name,
          `Argument description changed: ${field}`,
          'The model fills arguments from these descriptions, so the values it sends may change even though the schema has not.',
          oldFieldDescription === undefined ? '(none)' : truncate(oldFieldDescription),
          newFieldDescription === undefined ? '(none)' : truncate(newFieldDescription),
        );
      }

      const wasRequired = oldRequired.has(field);
      const isRequired = newRequired.has(field);
      if (!wasRequired && isRequired) {
        add(
          'breaking',
          name,
          `${field} is now required`,
          'Calls that omitted it will be rejected.',
        );
      } else if (wasRequired && !isRequired) {
        add('additive', name, `${field} is no longer required`, 'Existing calls remain valid.');
      }
    }
  }

  const counts: Record<ChangeKind, number> = { breaking: 0, behavioral: 0, additive: 0 };
  for (const change of changes) counts[change.kind]++;

  const order: Record<ChangeKind, number> = { breaking: 0, behavioral: 1, additive: 2 };
  changes.sort((a, b) => order[a.kind] - order[b.kind] || a.tool.localeCompare(b.tool));

  return { changes, counts, toolsBefore: before.length, toolsAfter: after.length };
}

const HEADINGS: Array<[ChangeKind, string, string]> = [
  ['breaking', 'BREAKING', 'Existing calls stop working.'],
  ['behavioral', 'BEHAVIORAL', 'Nothing breaks; the model may behave differently.'],
  ['additive', 'ADDITIVE', 'Existing calls are unaffected.'],
];

export function renderSchemaDiff(diff: SchemaDiff, hideAdditive: boolean): string {
  const lines: string[] = [
    `${diff.toolsBefore} → ${diff.toolsAfter} tools   ` +
      `${diff.counts.breaking} breaking · ${diff.counts.behavioral} behavioral · ${diff.counts.additive} additive`,
    '',
  ];

  if (diff.changes.length === 0) {
    lines.push('The two tool sets are identical.', '');
    return lines.join('\n');
  }

  for (const [kind, heading, blurb] of HEADINGS) {
    if (kind === 'additive' && hideAdditive) continue;
    const group = diff.changes.filter((c) => c.kind === kind);
    if (group.length === 0) continue;

    lines.push(`${heading} (${group.length})   ${blurb}`);
    for (const change of group) {
      lines.push(`  ${change.tool}: ${change.title}`);
      lines.push(`      ${change.detail}`);
      if (change.before !== undefined && change.after !== undefined) {
        lines.push(`      was  ${change.before}`);
        lines.push(`      now  ${change.after}`);
      }
    }
    lines.push('');
  }

  if (hideAdditive && diff.counts.additive > 0) {
    lines.push(`${diff.counts.additive} additive change${diff.counts.additive === 1 ? '' : 's'} hidden.`, '');
  }

  if (diff.counts.behavioral > 0) {
    lines.push(
      'Behavioral changes are the ones that do not announce themselves. A tool whose',
      'description changed still has the same signature, still validates, and may now',
      'be chosen in situations it was not chosen in before.',
    );
  }

  return lines.join('\n') + '\n';
}
