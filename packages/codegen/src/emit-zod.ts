import type { Schema, StringSchema } from './schema.js';
import { splitNullable, schemaKey } from './schema.js';
import { collectNamedTypes, isSafeIdentifier } from './naming.js';
import type { EmitResult } from './emit-typescript.js';

export interface ZodOptions {
  rootName: string;
  /** Zod 4 renamed a few builders; emit whichever the project is on. */
  version: 'v3' | 'v4';
  /** Also emit `export type X = z.infer<typeof XSchema>`. */
  inferTypes: boolean;
  /** Apply .email()/.uuid()/.datetime() when a format was detected. */
  applyFormats: boolean;
  inferLiteralUnions: boolean;
  schemaSuffix: string;
}

export const defaultZodOptions: ZodOptions = {
  rootName: 'Root',
  version: 'v4',
  inferTypes: true,
  applyFormats: true,
  inferLiteralUnions: true,
  schemaSuffix: 'Schema',
};

function literalValues(s: StringSchema, enabled: boolean): string[] | undefined {
  if (!enabled || s.tooManyValues || !s.values) return undefined;
  const values = [...s.values];
  if (values.length === 0 || values.length > 12) return undefined;
  if (s.samples < values.length * 2) return undefined;
  if (values.some((v) => v.length === 0 || v.length > 40)) return undefined;
  return values.sort();
}

const quote = (v: string): string => JSON.stringify(v);

function stringBuilder(s: StringSchema, opts: ZodOptions): string {
  if (!opts.applyFormats || !s.format) return 'z.string()';
  // Zod 4 promoted the string formats to top-level schemas and deprecated the
  // chained methods; Zod 3 only has the chained form.
  const v4 = opts.version === 'v4';
  switch (s.format) {
    case 'email':
      return v4 ? 'z.email()' : 'z.string().email()';
    case 'uuid':
      return v4 ? 'z.uuid()' : 'z.string().uuid()';
    case 'uri':
      return v4 ? 'z.url()' : 'z.string().url()';
    case 'date-time':
      return v4 ? 'z.iso.datetime()' : 'z.string().datetime()';
    case 'date':
      return v4 ? 'z.iso.date()' : 'z.string().date()';
    case 'ipv4':
      return v4 ? 'z.ipv4()' : 'z.string().ip({ version: "v4" })';
  }
}

export function emitZod(root: Schema, options: ZodOptions): EmitResult {
  const warnings: string[] = [];
  const { types, names, rootName } = collectNamedTypes(root, options.rootName);
  const constName = (typeName: string): string => `${typeName}${options.schemaSuffix}`;
  let quotedKeys = 0;

  const render = (schema: Schema, indent: string): string => {
    const { schema: bare, nullable } = splitNullable(schema);
    const rendered = renderBare(bare, indent);
    return nullable ? `${rendered}.nullable()` : rendered;
  };

  const renderBare = (schema: Schema, indent: string): string => {
    switch (schema.kind) {
      case 'unknown':
        return 'z.unknown()';
      case 'null':
        return 'z.null()';
      case 'boolean':
        return 'z.boolean()';
      case 'number':
        return schema.integer ? 'z.number().int()' : 'z.number()';
      case 'string': {
        const literals = literalValues(schema, options.inferLiteralUnions);
        if (literals) return `z.enum([${literals.map(quote).join(', ')}])`;
        return stringBuilder(schema, options);
      }
      case 'array':
        return `z.array(${render(schema.items, indent)})`;
      case 'object': {
        const name = names.get(schemaKey(schema));
        // Named types are emitted as their own const, so reference it. Anonymous
        // objects (only reachable when naming was skipped) inline instead.
        return name ? constName(name) : renderObjectLiteral(schema, indent);
      }
      case 'union':
        return `z.union([${schema.options.map((o) => render(o, indent)).join(', ')}])`;
    }
  };

  const renderObjectLiteral = (
    schema: Extract<Schema, { kind: 'object' }>,
    indent: string,
  ): string => {
    if (schema.fields.size === 0) return 'z.object({})';
    const inner = indent + '  ';
    const lines: string[] = ['z.object({'];
    for (const [key, field] of schema.fields) {
      const safe = isSafeIdentifier(key);
      if (!safe) quotedKeys++;
      const name = safe ? key : quote(key);
      const value = render(field.schema, inner);
      lines.push(`${inner}${name}: ${field.optional ? `${value}.optional()` : value},`);
    }
    lines.push(`${indent}})`);
    return lines.join('\n');
  };

  const blocks: string[] = [`import { z } from "zod";`];

  for (const t of types) {
    const literal = renderObjectLiteral(t.schema, '');
    blocks.push(`export const ${constName(t.name)} = ${literal};`);
    if (options.inferTypes) {
      blocks.push(`export type ${t.name} = z.infer<typeof ${constName(t.name)}>;`);
    }
  }

  const { schema: bareRoot } = splitNullable(root);
  if (bareRoot.kind !== 'object') {
    blocks.push(`export const ${constName(rootName)} = ${render(root, '')};`);
    if (options.inferTypes) {
      blocks.push(`export type ${rootName} = z.infer<typeof ${constName(rootName)}>;`);
    }
  }

  if (quotedKeys > 0) {
    warnings.push(
      `${quotedKeys} key${quotedKeys === 1 ? ' was' : 's were'} not a valid identifier and had to be quoted.`,
    );
  }

  return { code: blocks.join('\n\n') + '\n', warnings, typeCount: types.length };
}
