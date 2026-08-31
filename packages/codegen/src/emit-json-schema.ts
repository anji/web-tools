import type { Schema, StringSchema } from './schema.js';
import { splitNullable, schemaKey } from './schema.js';
import { collectNamedTypes } from './naming.js';
import type { EmitResult } from './emit-typescript.js';

export interface JsonSchemaOptions {
  rootName: string;
  draft: '2020-12' | 'draft-07';
  /** Hoist repeated object shapes into $defs and reference them. */
  useDefs: boolean;
  /** Emit "required" arrays for non-optional fields. */
  markRequired: boolean;
  /** Set additionalProperties:false, which is stricter than most APIs want. */
  closed: boolean;
  applyFormats: boolean;
  inferLiteralUnions: boolean;
}

export const defaultJsonSchemaOptions: JsonSchemaOptions = {
  rootName: 'Root',
  draft: '2020-12',
  useDefs: true,
  markRequired: true,
  closed: false,
  applyFormats: true,
  inferLiteralUnions: true,
};

type JsonSchemaNode = Record<string, unknown>;

function enumValues(s: StringSchema, enabled: boolean): string[] | undefined {
  if (!enabled || s.tooManyValues || !s.values) return undefined;
  const values = [...s.values];
  if (values.length === 0 || values.length > 12) return undefined;
  if (s.samples < values.length * 2) return undefined;
  if (values.some((v) => v.length === 0 || v.length > 40)) return undefined;
  return values.sort();
}

export function emitJsonSchema(root: Schema, options: JsonSchemaOptions): EmitResult {
  const { types, names } = collectNamedTypes(root, options.rootName);
  const warnings: string[] = [];
  const defsKey = options.draft === '2020-12' ? '$defs' : 'definitions';
  const refBase = `#/${defsKey}/`;

  const build = (schema: Schema): JsonSchemaNode => {
    const { schema: bare, nullable } = splitNullable(schema);
    const node = buildBare(bare);
    if (!nullable) return node;

    // A $ref cannot carry sibling keywords in draft-07, so nullable refs have to
    // be expressed as a composition rather than a type array.
    if ('$ref' in node) return { anyOf: [node, { type: 'null' }] };
    if (typeof node['type'] === 'string') return { ...node, type: [node['type'], 'null'] };
    return { anyOf: [node, { type: 'null' }] };
  };

  const buildBare = (schema: Schema): JsonSchemaNode => {
    switch (schema.kind) {
      case 'unknown':
        return {};
      case 'null':
        return { type: 'null' };
      case 'boolean':
        return { type: 'boolean' };
      case 'number':
        return { type: schema.integer ? 'integer' : 'number' };
      case 'string': {
        const values = enumValues(schema, options.inferLiteralUnions);
        if (values) return { type: 'string', enum: values };
        return options.applyFormats && schema.format
          ? { type: 'string', format: schema.format }
          : { type: 'string' };
      }
      case 'array':
        return { type: 'array', items: build(schema.items) };
      case 'object': {
        const name = options.useDefs ? names.get(schemaKey(schema)) : undefined;
        return name ? { $ref: refBase + name } : buildObject(schema);
      }
      case 'union':
        return { anyOf: schema.options.map(buildBare) };
    }
  };

  const buildObject = (schema: Extract<Schema, { kind: 'object' }>): JsonSchemaNode => {
    const properties: JsonSchemaNode = {};
    const required: string[] = [];
    for (const [key, field] of schema.fields) {
      properties[key] = build(field.schema);
      if (!field.optional) required.push(key);
    }
    const node: JsonSchemaNode = { type: 'object', properties };
    if (options.markRequired && required.length > 0) node['required'] = required;
    if (options.closed) node['additionalProperties'] = false;
    return node;
  };

  const defs: JsonSchemaNode = {};
  if (options.useDefs) {
    for (const t of types) defs[t.name] = buildObject(t.schema);
  }

  const { schema: bareRoot } = splitNullable(root);
  const rootIsNamedObject = bareRoot.kind === 'object' && options.useDefs;

  const document: JsonSchemaNode = {
    $schema:
      options.draft === '2020-12'
        ? 'https://json-schema.org/draft/2020-12/schema'
        : 'http://json-schema.org/draft-07/schema#',
    title: options.rootName,
    ...(rootIsNamedObject
      ? { $ref: refBase + (names.get(schemaKey(bareRoot)) ?? options.rootName) }
      : build(root)),
  };

  if (options.useDefs && Object.keys(defs).length > 0) document[defsKey] = defs;

  if (options.closed) {
    warnings.push(
      'additionalProperties:false rejects any field not seen in your sample. Most real APIs add fields over time.',
    );
  }

  return {
    code: JSON.stringify(document, null, 2) + '\n',
    warnings,
    typeCount: Object.keys(defs).length || 1,
  };
}
