import type { Schema } from './schema.js';
import { splitNullable, schemaKey } from './schema.js';
import { collectNamedTypes, goCase } from './naming.js';
import type { EmitResult } from './emit-typescript.js';

export interface GoOptions {
  rootName: string;
  /** Emitted as a `package x` header. Empty string omits it. */
  packageName: string;
  /**
   * Pointer types for fields that are optional or nullable.
   *
   * This is the whole correctness argument for this tool. A converter that
   * reads one array element and emits `Bio string` will silently decode null
   * as "" -- and any code that then dereferences a nested struct panics. A
   * pointer preserves the difference between absent, null, and empty.
   */
  usePointers: boolean;
  /** Append ,omitempty to the json tag of optional fields. */
  omitempty: boolean;
  intType: 'int' | 'int64';
  /** time.Time for strings that parsed as RFC 3339. */
  useTimeType: boolean;
  /** `any` (Go 1.18+) rather than `interface{}`. */
  useAnyKeyword: boolean;
}

export const defaultGoOptions: GoOptions = {
  rootName: 'Root',
  packageName: 'main',
  usePointers: true,
  omitempty: true,
  intType: 'int64',
  useTimeType: false,
  useAnyKeyword: true,
};

const GO_RESERVED = new Set([
  'break','case','chan','const','continue','default','defer','else','fallthrough',
  'for','func','go','goto','if','import','interface','map','package','range',
  'return','select','struct','switch','type','var',
]);

export function emitGo(root: Schema, options: GoOptions): EmitResult {
  const warnings: string[] = [];
  const base = collectNamedTypes(root, options.rootName);

  // collectNamedTypes names types in plain PascalCase; re-case them for Go so
  // an `api_url` field yields APIURL rather than ApiUrl, keeping uniqueness.
  const used = new Set<string>();
  const rename = new Map<string, string>();
  const goName = (name: string): string => {
    let candidate = goCase(name) || 'T';
    if (GO_RESERVED.has(candidate)) candidate = `${candidate}Type`;
    if (used.has(candidate)) {
      let n = 2;
      while (used.has(`${candidate}${n}`)) n++;
      candidate = `${candidate}${n}`;
    }
    used.add(candidate);
    return candidate;
  };
  for (const [key, name] of base.names) rename.set(key, goName(name));
  const rootAlias = base.types.length > 0 || true ? goName(base.rootName) : base.rootName;

  const anyType = options.useAnyKeyword ? 'any' : 'interface{}';
  let usesTime = false;

  const render = (schema: Schema, pointerIfComposite: boolean): string => {
    const { schema: bare, nullable } = splitNullable(schema);
    const rendered = renderBare(bare);
    // A nullable scalar or struct becomes a pointer; slices and maps are
    // already nil-able, so pointing to them adds noise without adding meaning.
    const pointable = !rendered.startsWith('[]') && !rendered.startsWith('map[') && rendered !== anyType;
    return (nullable || pointerIfComposite) && options.usePointers && pointable
      ? `*${rendered}`
      : rendered;
  };

  const renderBare = (schema: Schema): string => {
    switch (schema.kind) {
      case 'unknown':
      case 'null':
      case 'union':
        return anyType;
      case 'boolean':
        return 'bool';
      case 'number':
        return schema.integer ? options.intType : 'float64';
      case 'string':
        if (options.useTimeType && schema.format === 'date-time') {
          usesTime = true;
          return 'time.Time';
        }
        return 'string';
      case 'array': {
        const { schema: itemBare, nullable: itemNullable } = splitNullable(schema.items);
        if (itemBare.kind === 'unknown') return `[]${anyType}`;
        const inner = renderBare(itemBare);
        const pointable = !inner.startsWith('[]') && inner !== anyType;
        return itemNullable && options.usePointers && pointable ? `[]*${inner}` : `[]${inner}`;
      }
      case 'object': {
        const name = rename.get(schemaKey(schema));
        return name ?? `map[string]${anyType}`;
      }
    }
  };

  const renderStruct = (name: string, schema: Extract<Schema, { kind: 'object' }>): string => {
    if (schema.fields.size === 0) return `type ${name} struct{}`;

    // gofmt aligns the name, type and tag columns; matching that is the
    // difference between output people paste and output people reformat.
    const rows: Array<[string, string, string]> = [];
    const fieldNames = new Set<string>();

    for (const [key, field] of schema.fields) {
      let fieldName = goCase(key);
      if (fieldName === '') fieldName = 'Field';
      if (fieldNames.has(fieldName)) {
        let n = 2;
        while (fieldNames.has(`${fieldName}${n}`)) n++;
        fieldName = `${fieldName}${n}`;
      }
      fieldNames.add(fieldName);

      const type = render(field.schema, field.optional);
      const omit = options.omitempty && field.optional ? ',omitempty' : '';
      rows.push([fieldName, type, `\`json:"${key}${omit}"\``]);
    }

    const nameWidth = Math.max(...rows.map((r) => r[0].length));
    const typeWidth = Math.max(...rows.map((r) => r[1].length));
    const lines = rows.map(
      ([n, t, tag]) => `\t${n.padEnd(nameWidth)} ${t.padEnd(typeWidth)} ${tag}`,
    );
    return `type ${name} struct {\n${lines.join('\n')}\n}`;
  };

  const blocks: string[] = [];
  for (const t of base.types) {
    blocks.push(renderStruct(rename.get(schemaKey(t.schema))!, t.schema));
  }

  const { schema: bareRoot } = splitNullable(root);
  if (bareRoot.kind !== 'object') {
    blocks.push(`type ${rootAlias} ${renderBare(bareRoot)}`);
  }
  if (blocks.length === 0) blocks.push(`type ${rootAlias} ${anyType}`);

  const header: string[] = [];
  if (options.packageName.trim()) header.push(`package ${options.packageName.trim()}\n`);
  if (usesTime) header.push(`import "time"\n`);

  if (!options.usePointers) {
    warnings.push(
      'Pointers are off, so an optional or null field decodes to the zero value and you cannot tell "absent" from "empty". Leave them on unless you know the field is always present.',
    );
  }

  return {
    code: header.join('\n') + (header.length ? '\n' : '') + blocks.join('\n\n') + '\n',
    warnings,
    typeCount: blocks.length,
  };
}
