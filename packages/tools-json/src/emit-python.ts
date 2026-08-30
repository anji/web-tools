import type { Schema } from './schema.js';
import { splitNullable, schemaKey } from './schema.js';
import { collectNamedTypes, snakeCase } from './naming.js';
import type { EmitResult } from './emit-typescript.js';

export interface PythonOptions {
  rootName: string;
  style: 'dataclass' | 'pydantic';
  /** `str | None` (3.10+) rather than `Optional[str]`. */
  modernUnions: boolean;
  /** datetime/date/UUID instead of str where a format was detected. */
  useRichTypes: boolean;
  /** Rename keys to snake_case, keeping the original as an alias. */
  snakeCaseFields: boolean;
}

export const defaultPythonOptions: PythonOptions = {
  rootName: 'Root',
  style: 'pydantic',
  modernUnions: true,
  useRichTypes: true,
  snakeCaseFields: true,
};

const PYTHON_KEYWORDS = new Set([
  'False','None','True','and','as','assert','async','await','break','class',
  'continue','def','del','elif','else','except','finally','for','from','global',
  'if','import','in','is','lambda','nonlocal','not','or','pass','raise','return',
  'try','while','with','yield',
]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function emitPython(root: Schema, options: PythonOptions): EmitResult {
  const warnings: string[] = [];
  const base = collectNamedTypes(root, options.rootName);
  const pydantic = options.style === 'pydantic';
  const typingImports = new Set<string>();
  const stdImports = new Set<string>();
  const pydanticImports = new Set<string>();
  let usedEmailStr = false;
  let needsDataclassField = false;
  let aliasedInDataclass = 0;

  const optional = (inner: string): string => {
    if (options.modernUnions) return `${inner} | None`;
    typingImports.add('Optional');
    return `Optional[${inner}]`;
  };

  const render = (schema: Schema, isOptional: boolean): string => {
    const { schema: bare, nullable } = splitNullable(schema);
    const rendered = renderBare(bare);
    return nullable || isOptional ? optional(rendered) : rendered;
  };

  const renderBare = (schema: Schema): string => {
    switch (schema.kind) {
      case 'unknown':
      case 'null':
      case 'union':
        typingImports.add('Any');
        return 'Any';
      case 'boolean':
        return 'bool';
      case 'number':
        return schema.integer ? 'int' : 'float';
      case 'string': {
        if (!options.useRichTypes || !schema.format) return 'str';
        switch (schema.format) {
          case 'date-time':
            stdImports.add('from datetime import datetime');
            return 'datetime';
          case 'date':
            stdImports.add('from datetime import date');
            return 'date';
          case 'uuid':
            stdImports.add('from uuid import UUID');
            return 'UUID';
          case 'email':
            if (pydantic) {
              pydanticImports.add('EmailStr');
              usedEmailStr = true;
              return 'EmailStr';
            }
            return 'str';
          default:
            return 'str';
        }
      }
      case 'array': {
        const { schema: itemBare, nullable: itemNullable } = splitNullable(schema.items);
        if (itemBare.kind === 'unknown') {
          typingImports.add('Any');
          return 'list[Any]';
        }
        const inner = renderBare(itemBare);
        return `list[${itemNullable ? optional(inner) : inner}]`;
      }
      case 'object': {
        const name = base.names.get(schemaKey(schema));
        if (name) return name;
        typingImports.add('Any');
        return 'dict[str, Any]';
      }
    }
  };

  const renderClass = (typeName: string, schema: Extract<Schema, { kind: 'object' }>): string => {
    const parent = pydantic ? '(BaseModel)' : '';
    const decorator = pydantic ? '' : '@dataclass\n';
    if (schema.fields.size === 0) {
      return `${decorator}class ${typeName}${parent}:\n    pass`;
    }

    const entries = [...schema.fields.entries()];
    // A dataclass field with a default cannot precede one without, or Python
    // raises "non-default argument follows default argument" at import time.
    // Knowing which fields are optional is exactly what lets us order them.
    const ordered = [
      ...entries.filter(([, f]) => !f.optional),
      ...entries.filter(([, f]) => f.optional),
    ];
    const reordered = ordered.some(([k], i) => entries[i]?.[0] !== k);

    const taken = new Set<string>();
    const lines: string[] = [`${decorator}class ${typeName}${parent}:`];

    for (const [key, field] of ordered) {
      let name = options.snakeCaseFields ? snakeCase(key) : key;
      if (!IDENTIFIER.test(name)) name = snakeCase(key);
      if (!IDENTIFIER.test(name) || name === '') name = 'field';
      // Pydantic treats a leading underscore as a private attribute and refuses
      // the model outright, so a key like "2fa" cannot become "_2fa".
      if (name.startsWith('_')) name = `field${name}`;
      if (PYTHON_KEYWORDS.has(name)) name = `${name}_`;
      if (taken.has(name)) {
        let n = 2;
        while (taken.has(`${name}${n}`)) n++;
        name = `${name}${n}`;
      }
      taken.add(name);

      const type = render(field.schema, field.optional);
      const aliased = name !== key;

      if (pydantic) {
        if (aliased) {
          pydanticImports.add('Field');
          const def = field.optional ? 'None, ' : '';
          lines.push(`    ${name}: ${type} = Field(${def}alias="${key}")`);
        } else {
          lines.push(`    ${name}: ${type}${field.optional ? ' = None' : ''}`);
        }
      } else {
        if (aliased) {
          needsDataclassField = true;
          aliasedInDataclass++;
          const meta = `metadata={"json_key": "${key}"}`;
          lines.push(
            field.optional
              ? `    ${name}: ${type} = field(default=None, ${meta})`
              : `    ${name}: ${type} = field(${meta})`,
          );
        } else {
          lines.push(`    ${name}: ${type}${field.optional ? ' = None' : ''}`);
        }
      }
    }

    if (reordered && !pydantic) {
      warnings.push(
        `Fields in ${typeName} were reordered so required ones come first -- a dataclass cannot have a defaulted field before a non-defaulted one.`,
      );
    }

    return lines.join('\n');
  };

  const blocks: string[] = [];
  for (const t of base.types) blocks.push(renderClass(t.name, t.schema));

  const { schema: bareRoot } = splitNullable(root);
  if (bareRoot.kind !== 'object') {
    typingImports.add('TypeAlias');
    blocks.push(`${base.rootName}: TypeAlias = ${renderBare(bareRoot)}`);
  }
  if (blocks.length === 0) {
    typingImports.add('Any');
    blocks.push(`${base.rootName}: TypeAlias = Any`);
  }

  const header: string[] = [];
  if (!pydantic) {
    // One dataclasses import, not two: `field` is only needed when a key had
    // to be renamed.
    stdImports.add(
      needsDataclassField
        ? 'from dataclasses import dataclass, field'
        : 'from dataclasses import dataclass',
    );
  }
  for (const line of [...stdImports].sort()) header.push(line);
  if (typingImports.size > 0) {
    header.push(`from typing import ${[...typingImports].sort().join(', ')}`);
  }
  if (pydantic) {
    pydanticImports.add('BaseModel');
    header.push(`from pydantic import ${[...pydanticImports].sort().join(', ')}`);
  }

  if (usedEmailStr) {
    warnings.push('EmailStr needs the email extra: pip install "pydantic[email]".');
  }
  if (aliasedInDataclass > 0) {
    warnings.push(
      `${aliasedInDataclass} key${aliasedInDataclass === 1 ? '' : 's'} could not be used as a Python identifier and ${aliasedInDataclass === 1 ? 'was' : 'were'} renamed. Plain dataclasses do not map JSON keys themselves -- the original key is recorded in metadata for your decoder, or switch to Pydantic, which applies the alias for you.`,
    );
  }

  return {
    code: header.join('\n') + (header.length ? '\n\n\n' : '') + blocks.join('\n\n\n') + '\n',
    warnings,
    typeCount: base.types.length || 1,
  };
}
