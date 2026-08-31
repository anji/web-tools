import type { Schema, StringSchema } from './schema.js';
import { splitNullable, schemaKey } from './schema.js';
import { collectNamedTypes, isSafeIdentifier } from './naming.js';

export interface TypeScriptOptions {
  rootName: string;
  /** `interface X {}` vs `type X = {}`. Interfaces are the common house style. */
  useInterfaces: boolean;
  readonlyFields: boolean;
  /** `field?: T` vs `field: T | undefined`. */
  optionalStyle: 'question' | 'undefined';
  /** Turn small, repeated string sets into literal unions. */
  inferLiteralUnions: boolean;
  exported: boolean;
}

export const defaultTypeScriptOptions: TypeScriptOptions = {
  rootName: 'Root',
  useInterfaces: true,
  readonlyFields: false,
  optionalStyle: 'question',
  inferLiteralUnions: true,
  exported: true,
};

export interface EmitResult {
  code: string;
  warnings: string[];
  typeCount: number;
}

/**
 * A string field becomes a literal union only when the evidence supports it:
 * a bounded set of values, each seen more than once on average. A single sample
 * object should produce `name: string`, not `name: "Ada"`.
 */
function literalUnionValues(s: StringSchema, enabled: boolean): string[] | undefined {
  if (!enabled || s.tooManyValues || !s.values) return undefined;
  const values = [...s.values];
  if (values.length === 0 || values.length > 12) return undefined;
  if (s.samples < values.length * 2) return undefined;
  if (values.some((v) => v.length === 0 || v.length > 40)) return undefined;
  return values.sort();
}

const quote = (v: string): string => JSON.stringify(v);

export function emitTypeScript(root: Schema, options: TypeScriptOptions): EmitResult {
  const warnings: string[] = [];
  const { types, names, rootName } = collectNamedTypes(root, options.rootName);
  let quotedKeys = 0;
  let literalUnions = 0;

  const render = (schema: Schema): string => {
    const { schema: bare, nullable } = splitNullable(schema);
    const rendered = renderBare(bare);
    return nullable ? `${rendered} | null` : rendered;
  };

  const renderBare = (schema: Schema): string => {
    switch (schema.kind) {
      case 'unknown':
        return 'unknown';
      case 'null':
        return 'null';
      case 'boolean':
        return 'boolean';
      case 'number':
        return 'number';
      case 'string': {
        const literals = literalUnionValues(schema, options.inferLiteralUnions);
        if (literals) {
          literalUnions++;
          return literals.map(quote).join(' | ');
        }
        return 'string';
      }
      case 'array': {
        const inner = render(schema.items);
        // `(a | b)[]` needs the parens; `Foo[]` does not.
        return /[|&]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
      }
      case 'object': {
        const name = names.get(schemaKey(schema));
        return name ?? 'Record<string, unknown>';
      }
      case 'union':
        return schema.options.map(renderBare).join(' | ');
    }
  };

  const renderBody = (schema: Extract<Schema, { kind: 'object' }>): string => {
    if (schema.fields.size === 0) return '{}';
    const lines: string[] = ['{'];
    for (const [key, field] of schema.fields) {
      const safe = isSafeIdentifier(key);
      if (!safe) quotedKeys++;
      const name = safe ? key : quote(key);
      const readonly = options.readonlyFields ? 'readonly ' : '';
      const useQuestion = field.optional && options.optionalStyle === 'question';
      const marker = useQuestion ? '?' : '';
      const type =
        field.optional && options.optionalStyle === 'undefined'
          ? `${render(field.schema)} | undefined`
          : render(field.schema);
      lines.push(`  ${readonly}${name}${marker}: ${type};`);
    }
    lines.push('}');
    return lines.join('\n');
  };

  const prefix = options.exported ? 'export ' : '';
  const blocks: string[] = [];

  for (const t of types) {
    const body = renderBody(t.schema);
    blocks.push(
      options.useInterfaces
        ? `${prefix}interface ${t.name} ${body}`
        : `${prefix}type ${t.name} = ${body};`,
    );
  }

  // A root that is an array (or a primitive) has no interface of its own, so it
  // gets an alias that points at the element type.
  const { schema: bareRoot } = splitNullable(root);
  if (bareRoot.kind !== 'object') {
    blocks.push(`${prefix}type ${rootName} = ${render(root)};`);
  }

  if (blocks.length === 0) blocks.push(`${prefix}type ${rootName} = ${render(root)};`);

  if (quotedKeys > 0) {
    warnings.push(
      `${quotedKeys} key${quotedKeys === 1 ? ' was' : 's were'} not a valid TypeScript identifier and had to be quoted.`,
    );
  }
  if (literalUnions > 0) {
    warnings.push(
      `${literalUnions} field${literalUnions === 1 ? '' : 's'} looked like an enum and became a literal union. Turn off "Infer literal unions" if that is too strict.`,
    );
  }

  return { code: blocks.join('\n\n') + '\n', warnings, typeCount: blocks.length };
}
