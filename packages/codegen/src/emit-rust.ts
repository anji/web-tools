import type { Schema } from './schema.js';
import { splitNullable, schemaKey } from './schema.js';
import { collectNamedTypes, snakeCase } from './naming.js';
import type { EmitResult } from './emit-typescript.js';

export interface RustOptions {
  rootName: string;
  /** Extra traits alongside Serialize and Deserialize. */
  derives: string;
  /**
   * Option<T> for optional and nullable fields.
   *
   * Rust has no null, so this is not a nicety: a plain String simply cannot
   * decode a JSON null, and serde returns a "missing field" or "invalid type"
   * error at runtime rather than doing anything silent. Getting it wrong turns
   * a working payload into a parse failure.
   */
  useOption: boolean;
  /** skip_serializing_if on Option fields, so None round-trips as absent. */
  skipSerializingNone: boolean;
  /** chrono::DateTime<Utc> and uuid::Uuid for detected formats. */
  useRichTypes: boolean;
  /** Emit `pub` on structs and fields. */
  publicItems: boolean;
}

export const defaultRustOptions: RustOptions = {
  rootName: 'Root',
  derives: 'Debug, Clone',
  useOption: true,
  skipSerializingNone: true,
  useRichTypes: false,
  publicItems: true,
};

const RUST_KEYWORDS = new Set([
  'as','break','const','continue','crate','dyn','else','enum','extern','false',
  'fn','for','if','impl','in','let','loop','match','mod','move','mut','pub',
  'ref','return','self','Self','static','struct','super','trait','true','type',
  'unsafe','use','where','while','async','await','become','box','do','final',
  'macro','override','priv','try','typeof','unsized','virtual','yield',
]);

/** Keywords that cannot be written as raw identifiers. */
const NOT_RAW = new Set(['crate', 'self', 'Self', 'super']);

export function emitRust(root: Schema, options: RustOptions): EmitResult {
  const warnings: string[] = [];
  const base = collectNamedTypes(root, options.rootName);
  const uses = new Set<string>(['use serde::{Deserialize, Serialize};']);
  let usedValue = false;

  const render = (schema: Schema, optional: boolean): string => {
    const { schema: bare, nullable } = splitNullable(schema);
    const rendered = renderBare(bare);
    return (nullable || optional) && options.useOption ? `Option<${rendered}>` : rendered;
  };

  const renderBare = (schema: Schema): string => {
    switch (schema.kind) {
      case 'unknown':
      case 'null':
      case 'union':
        usedValue = true;
        uses.add('use serde_json::Value;');
        return 'Value';
      case 'boolean':
        return 'bool';
      case 'number':
        return schema.integer ? 'i64' : 'f64';
      case 'string':
        if (options.useRichTypes && schema.format === 'date-time') {
          uses.add('use chrono::{DateTime, Utc};');
          return 'DateTime<Utc>';
        }
        if (options.useRichTypes && schema.format === 'uuid') {
          uses.add('use uuid::Uuid;');
          return 'Uuid';
        }
        return 'String';
      case 'array': {
        const { schema: itemBare, nullable: itemNullable } = splitNullable(schema.items);
        if (itemBare.kind === 'unknown') {
          usedValue = true;
          uses.add('use serde_json::Value;');
          return 'Vec<Value>';
        }
        const inner = renderBare(itemBare);
        return `Vec<${itemNullable && options.useOption ? `Option<${inner}>` : inner}>`;
      }
      case 'object': {
        const name = base.names.get(schemaKey(schema));
        if (name) return name;
        usedValue = true;
        uses.add('use serde_json::Value;');
        uses.add('use std::collections::HashMap;');
        return 'HashMap<String, Value>';
      }
    }
  };

  const vis = options.publicItems ? 'pub ' : '';

  const renderStruct = (name: string, schema: Extract<Schema, { kind: 'object' }>): string => {
    const derives = ['Serialize', 'Deserialize', ...options.derives.split(',').map((d) => d.trim())]
      .filter(Boolean)
      .join(', ');
    const head = `#[derive(${derives})]\n${vis}struct ${name}`;
    if (schema.fields.size === 0) return `${head};`;

    const lines: string[] = [`${head} {`];
    const taken = new Set<string>();

    for (const [key, field] of schema.fields) {
      let name2 = snakeCase(key);
      if (name2 === '' || /^[0-9]/.test(name2)) name2 = `field_${name2}`;
      if (taken.has(name2)) {
        let n = 2;
        while (taken.has(`${name2}${n}`)) n++;
        name2 = `${name2}${n}`;
      }
      taken.add(name2);

      const attrs: string[] = [];
      // Rust's raw identifiers cover most keywords; the handful they cannot
      // express get a suffix instead.
      let ident = name2;
      if (RUST_KEYWORDS.has(name2)) ident = NOT_RAW.has(name2) ? `${name2}_` : `r#${name2}`;
      const bare = ident.startsWith('r#') ? ident.slice(2) : ident;
      if (bare !== key) attrs.push(`rename = "${key}"`);

      const type = render(field.schema, field.optional);
      if (options.skipSerializingNone && type.startsWith('Option<')) {
        attrs.push('skip_serializing_if = "Option::is_none"');
      }

      if (attrs.length > 0) lines.push(`    #[serde(${attrs.join(', ')})]`);
      lines.push(`    ${vis}${ident}: ${type},`);
    }

    lines.push('}');
    return lines.join('\n');
  };

  const blocks: string[] = [];
  for (const t of base.types) blocks.push(renderStruct(t.name, t.schema));

  const { schema: bareRoot } = splitNullable(root);
  if (bareRoot.kind !== 'object') {
    blocks.push(`${vis}type ${base.rootName} = ${renderBare(bareRoot)};`);
  }
  if (blocks.length === 0) blocks.push(`${vis}type ${base.rootName} = Value;`);

  if (usedValue) {
    warnings.push(
      'serde_json::Value appears where the sample had no consistent type. Those fields decode as untyped JSON -- narrow them by hand if you know the real shape.',
    );
  }
  if (!options.useOption) {
    warnings.push(
      'Option is off, so a null or missing value makes serde fail the whole deserialisation. Rust has no null to fall back on.',
    );
  }

  return {
    code: [...uses].sort().join('\n') + '\n\n' + blocks.join('\n\n') + '\n',
    warnings,
    typeCount: blocks.length,
  };
}
