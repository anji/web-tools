import type { Schema } from './schema.js';
import { splitNullable, schemaKey } from './schema.js';
import { collectNamedTypes, pascalCase, words } from './naming.js';
import type { EmitResult } from './emit-typescript.js';

export interface JavaOptions {
  rootName: string;
  /** Emitted as a `package x;` line in each file. Empty string omits it. */
  packageName: string;
  style: 'record' | 'class';
  /** Jackson @JsonProperty annotations preserving the original key. */
  jackson: boolean;
  /**
   * Boxed types (Integer, Long, Double, Boolean) for optional and nullable
   * fields.
   *
   * A Java primitive cannot hold null. Emit `int` for a field the API can omit
   * and Jackson either throws or quietly leaves 0 -- indistinguishable from a
   * zero the server actually sent. This is the Java form of the same bug
   * pointers solve in Go.
   */
  useBoxedTypes: boolean;
  /** java.time.Instant and java.util.UUID for detected formats. */
  useRichTypes: boolean;
}

export const defaultJavaOptions: JavaOptions = {
  rootName: 'Root',
  packageName: '',
  style: 'record',
  jackson: true,
  useBoxedTypes: true,
  useRichTypes: true,
};

const JAVA_KEYWORDS = new Set([
  'abstract','assert','boolean','break','byte','case','catch','char','class',
  'const','continue','default','do','double','else','enum','extends','final',
  'finally','float','for','goto','if','implements','import','instanceof','int',
  'interface','long','native','new','package','private','protected','public',
  'return','short','static','strictfp','super','switch','synchronized','this',
  'throw','throws','transient','try','void','volatile','while','var','record',
  'yield','sealed','permits','true','false','null',
]);

const BOXED: Record<string, string> = {
  int: 'Integer',
  long: 'Long',
  double: 'Double',
  boolean: 'Boolean',
};

function camelCase(input: string): string {
  const parts = words(input);
  if (parts.length === 0) return 'value';
  const joined =
    parts[0]! + parts.slice(1).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return /^[0-9]/.test(joined) ? `f${pascalCase(input)}` : joined;
}

export function emitJava(root: Schema, options: JavaOptions): EmitResult {
  const warnings: string[] = [];
  const base = collectNamedTypes(root, options.rootName);
  // Each type is presented as its own file, so imports are collected per file;
  // a shared set leaks java.util.List into classes that never use a list.
  let imports = new Set<string>();
  const isRecord = options.style === 'class' ? false : true;

  const render = (schema: Schema, optional: boolean): string => {
    const { schema: bare, nullable } = splitNullable(schema);
    const rendered = renderBare(bare);
    // Only primitives need boxing; everything else is already a reference type.
    if ((nullable || optional) && options.useBoxedTypes && BOXED[rendered]) {
      return BOXED[rendered]!;
    }
    return rendered;
  };

  const renderBare = (schema: Schema): string => {
    switch (schema.kind) {
      case 'unknown':
      case 'null':
      case 'union':
        return 'Object';
      case 'boolean':
        return 'boolean';
      case 'number':
        return schema.integer ? 'long' : 'double';
      case 'string':
        if (options.useRichTypes && schema.format === 'date-time') {
          imports.add('java.time.Instant');
          return 'Instant';
        }
        if (options.useRichTypes && schema.format === 'uuid') {
          imports.add('java.util.UUID');
          return 'UUID';
        }
        return 'String';
      case 'array': {
        imports.add('java.util.List');
        const { schema: itemBare } = splitNullable(schema.items);
        if (itemBare.kind === 'unknown') return 'List<Object>';
        const inner = renderBare(itemBare);
        // Generics cannot hold primitives.
        return `List<${BOXED[inner] ?? inner}>`;
      }
      case 'object': {
        const name = base.names.get(schemaKey(schema));
        if (name) return name;
        imports.add('java.util.Map');
        return 'Map<String, Object>';
      }
    }
  };

  interface Member {
    key: string;
    name: string;
    type: string;
  }

  const membersOf = (schema: Extract<Schema, { kind: 'object' }>): Member[] => {
    const taken = new Set<string>();
    const members: Member[] = [];
    for (const [key, field] of schema.fields) {
      let name = camelCase(key);
      if (JAVA_KEYWORDS.has(name)) name = `${name}Value`;
      if (taken.has(name)) {
        let n = 2;
        while (taken.has(`${name}${n}`)) n++;
        name = `${name}${n}`;
      }
      taken.add(name);
      members.push({ key, name, type: render(field.schema, field.optional) });
    }
    return members;
  };

  const annotation = (key: string, indent: string): string[] => {
    if (!options.jackson) return [];
    imports.add('com.fasterxml.jackson.annotation.JsonProperty');
    return [`${indent}@JsonProperty("${key}")`];
  };

  const renderRecord = (name: string, schema: Extract<Schema, { kind: 'object' }>): string => {
    const members = membersOf(schema);
    if (members.length === 0) return `public record ${name}() {\n}`;
    const params = members.map((m) => {
      const annotated = options.jackson ? `@JsonProperty("${m.key}") ` : '';
      if (options.jackson) imports.add('com.fasterxml.jackson.annotation.JsonProperty');
      return `        ${annotated}${m.type} ${m.name}`;
    });
    return `public record ${name}(\n${params.join(',\n')}\n) {\n}`;
  };

  const renderClass = (name: string, schema: Extract<Schema, { kind: 'object' }>): string => {
    const members = membersOf(schema);
    if (members.length === 0) return `public class ${name} {\n}`;

    const lines: string[] = [`public class ${name} {`];
    for (const m of members) {
      lines.push(...annotation(m.key, '    '));
      lines.push(`    private ${m.type} ${m.name};`);
    }
    for (const m of members) {
      const suffix = m.name.charAt(0).toUpperCase() + m.name.slice(1);
      const getter = m.type === 'boolean' ? `is${suffix}` : `get${suffix}`;
      lines.push('');
      lines.push(`    public ${m.type} ${getter}() {`);
      lines.push(`        return ${m.name};`);
      lines.push('    }');
      lines.push('');
      lines.push(`    public void set${suffix}(${m.type} ${m.name}) {`);
      lines.push(`        this.${m.name} = ${m.name};`);
      lines.push('    }');
    }
    lines.push('}');
    return lines.join('\n');
  };

  // Java allows only one public top-level type per file, so each generated type
  // is presented as its own file rather than concatenated into something that
  // would not compile.
  const fileHeader = (): string => {
    const header: string[] = [];
    if (options.packageName.trim()) header.push(`package ${options.packageName.trim()};`);
    const sorted = [...imports].sort();
    if (sorted.length > 0) header.push(sorted.map((i) => `import ${i};`).join('\n'));
    return header.length > 0 ? header.join('\n\n') + '\n\n' : '';
  };

  const blocks: string[] = [];
  for (const t of base.types) {
    imports = new Set<string>();
    const body = isRecord ? renderRecord(t.name, t.schema) : renderClass(t.name, t.schema);
    blocks.push(`// ${t.name}.java\n${fileHeader()}${body}`);
  }

  const { schema: bareRoot } = splitNullable(root);
  if (bareRoot.kind !== 'object') {
    imports = new Set<string>();
    // Generics cannot hold primitives, so the hint has to name the boxed type
    // or it is not valid Java.
    const rendered = renderBare(bareRoot);
    const boxed = BOXED[rendered] ?? rendered;
    blocks.push(
      `// Deserialise as: ${boxed}\n// mapper.readValue(json, new TypeReference<${boxed}>() {});`,
    );
  }
  if (blocks.length === 0) {
    imports = new Set<string>();
    blocks.push(`// ${base.rootName}.java\n${fileHeader()}public record ${base.rootName}() {\n}`);
  }

  if (!options.useBoxedTypes) {
    warnings.push(
      'Boxed types are off, so an optional or null number decodes to 0 and a boolean to false -- a Java primitive cannot represent absence.',
    );
  }

  return { code: blocks.join("\n\n"), warnings, typeCount: base.types.length || 1 };
}
