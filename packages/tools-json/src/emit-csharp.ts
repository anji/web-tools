import type { Schema } from './schema.js';
import { splitNullable, schemaKey } from './schema.js';
import { collectNamedTypes, pascalCase } from './naming.js';
import type { EmitResult } from './emit-typescript.js';

export interface CSharpOptions {
  rootName: string;
  /** Wraps the output in `namespace X;`. Empty string omits it. */
  namespace: string;
  style: 'class' | 'record';
  serializer: 'system-text-json' | 'newtonsoft' | 'none';
  /**
   * Emit `string?` for optional and nullable fields, plus `#nullable enable`.
   *
   * Without this a null in the payload deserialises to null anyway -- the
   * compiler just stops warning you about it, which is how a
   * NullReferenceException reaches production.
   */
  nullableRefTypes: boolean;
  intType: 'int' | 'long';
  /** DateTime for RFC 3339 strings and Guid for UUIDs. */
  useRichTypes: boolean;
}

export const defaultCSharpOptions: CSharpOptions = {
  rootName: 'Root',
  namespace: '',
  style: 'class',
  serializer: 'system-text-json',
  nullableRefTypes: true,
  intType: 'long',
  useRichTypes: true,
};

/** Value types can take `?` regardless of the nullable-reference-types setting. */
const VALUE_TYPES = new Set(['int', 'long', 'double', 'bool', 'DateTime', 'Guid']);

export function emitCSharp(root: Schema, options: CSharpOptions): EmitResult {
  const warnings: string[] = [];
  const base = collectNamedTypes(root, options.rootName);
  const usings = new Set<string>();
  let quotedNames = 0;

  const render = (schema: Schema, optional: boolean): string => {
    const { schema: bare, nullable } = splitNullable(schema);
    const rendered = renderBare(bare);
    const wantsNullable = nullable || optional;
    if (!wantsNullable) return rendered;
    // `object?` is meaningless and `List<T>?` needs NRT; value types never do.
    if (rendered === 'object') return rendered;
    if (VALUE_TYPES.has(rendered)) return `${rendered}?`;
    return options.nullableRefTypes ? `${rendered}?` : rendered;
  };

  const renderBare = (schema: Schema): string => {
    switch (schema.kind) {
      case 'unknown':
      case 'null':
      case 'union':
        return 'object';
      case 'boolean':
        return 'bool';
      case 'number':
        return schema.integer ? options.intType : 'double';
      case 'string':
        if (options.useRichTypes && schema.format === 'date-time') {
          usings.add('System');
          return 'DateTime';
        }
        if (options.useRichTypes && schema.format === 'uuid') {
          usings.add('System');
          return 'Guid';
        }
        return 'string';
      case 'array': {
        usings.add('System.Collections.Generic');
        const { schema: itemBare, nullable: itemNullable } = splitNullable(schema.items);
        if (itemBare.kind === 'unknown') return 'List<object>';
        const inner = renderBare(itemBare);
        const suffix =
          itemNullable && (VALUE_TYPES.has(inner) || options.nullableRefTypes) && inner !== 'object'
            ? '?'
            : '';
        return `List<${inner}${suffix}>`;
      }
      case 'object': {
        const name = base.names.get(schemaKey(schema));
        if (name) return name;
        usings.add('System.Collections.Generic');
        return 'Dictionary<string, object>';
      }
    }
  };

  const attribute = (key: string): string | undefined => {
    if (options.serializer === 'system-text-json') {
      usings.add('System.Text.Json.Serialization');
      return `    [JsonPropertyName("${key}")]`;
    }
    if (options.serializer === 'newtonsoft') {
      usings.add('Newtonsoft.Json');
      return `    [JsonProperty("${key}")]`;
    }
    return undefined;
  };

  const renderType = (typeName: string, schema: Extract<Schema, { kind: 'object' }>): string => {
    const keyword = options.style === 'record' ? 'record' : 'class';
    if (schema.fields.size === 0) return `public ${keyword} ${typeName}\n{\n}`;

    const lines: string[] = [`public ${keyword} ${typeName}`, '{'];
    const taken = new Set<string>();
    let first = true;

    for (const [key, field] of schema.fields) {
      let name = pascalCase(key);
      if (name === '') name = 'Value';
      // C# forbids a member with the same name as its enclosing type (CS0542),
      // which a payload like {"user": {"user": ...}} produces immediately.
      if (name === typeName) name = `${name}Value`;
      if (taken.has(name)) {
        let n = 2;
        while (taken.has(`${name}${n}`)) n++;
        name = `${name}${n}`;
      }
      taken.add(name);
      if (name !== key) quotedNames++;

      if (!first) lines.push('');
      first = false;

      const attr = attribute(key);
      if (attr) lines.push(attr);
      lines.push(`    public ${render(field.schema, field.optional)} ${name} { get; set; }`);
    }

    lines.push('}');
    return lines.join('\n');
  };

  const blocks: string[] = [];
  for (const t of base.types) blocks.push(renderType(t.name, t.schema));

  const { schema: bareRoot } = splitNullable(root);
  if (bareRoot.kind !== 'object') {
    // C# has no top-level type alias, so an array root is expressed as the
    // type you would actually deserialise into.
    blocks.push(
      `// Deserialise as: ${renderBare(bareRoot)}\n// JsonSerializer.Deserialize<${renderBare(bareRoot)}>(json);`,
    );
  }

  const header: string[] = [];
  if (options.nullableRefTypes) header.push('#nullable enable');
  const sortedUsings = [...usings].sort();
  if (sortedUsings.length > 0) header.push(sortedUsings.map((u) => `using ${u};`).join('\n'));
  if (options.namespace.trim()) header.push(`namespace ${options.namespace.trim()};`);

  if (!options.nullableRefTypes) {
    warnings.push(
      'Nullable reference types are off, so nullable string and class fields look non-null to the compiler even though the payload can send null.',
    );
  }
  if (quotedNames > 0) {
    warnings.push(
      `${quotedNames} propert${quotedNames === 1 ? 'y was' : 'ies were'} renamed to C# conventions; the serializer attribute preserves the original JSON key.`,
    );
  }

  return {
    code: header.join('\n\n') + (header.length ? '\n\n' : '') + blocks.join('\n\n') + '\n',
    warnings,
    typeCount: base.types.length || 1,
  };
}
