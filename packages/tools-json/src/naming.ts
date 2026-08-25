import type { Schema } from './schema.js';
import { schemaKey, splitNullable } from './schema.js';

const RESERVED = new Set([
  'break','case','catch','class','const','continue','debugger','default','delete','do','else',
  'enum','export','extends','false','finally','for','function','if','import','in','instanceof',
  'new','null','return','super','switch','this','throw','true','try','typeof','var','void',
  'while','with','as','implements','interface','let','package','private','protected','public',
  'static','yield','any','boolean','number','string','symbol','type','undefined','never','object',
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function isSafeIdentifier(name: string): boolean {
  return IDENTIFIER.test(name) && !RESERVED.has(name);
}

export function pascalCase(input: string): string {
  const words = input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const joined = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  // Type names cannot start with a digit.
  return /^[0-9]/.test(joined) ? `N${joined}` : joined;
}

/**
 * Deliberately naive English singularisation. It only ever affects a generated
 * type name, so being wrong is cosmetic -- `users` -> `User` is worth far more
 * than the occasional `data` -> `Datum` we skip by keeping this simple.
 */
export function singularize(word: string): string {
  if (/[^aeiou]ies$/i.test(word) && word.length > 4) return word.slice(0, -3) + 'y';
  if (/(ss|sh|ch|x|z)es$/i.test(word)) return word.slice(0, -2);
  if (/[^s]s$/i.test(word) && !/(us|is|ss)$/i.test(word)) return word.slice(0, -1);
  return word;
}

export interface NamedType {
  name: string;
  schema: Extract<Schema, { kind: 'object' }>;
}

export interface NamingResult {
  /** Post-order: dependencies appear before the types that reference them. */
  types: NamedType[];
  /** Structural key -> assigned type name. */
  names: Map<string, string>;
  /** The name for the root schema, if the root is an object or array of objects. */
  rootName: string;
}

/**
 * Walks the schema and assigns a name to every distinct object shape.
 *
 * Structurally identical objects collapse onto one type, which is what stops a
 * 200-element API response from generating 200 identical interfaces.
 */
export function collectNamedTypes(root: Schema, rootName: string): NamingResult {
  const names = new Map<string, string>();
  const types: NamedType[] = [];
  const used = new Set<string>();

  const claim = (preferred: string, parentHint: string): string => {
    const base = pascalCase(preferred) || 'Type';
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    const prefixed = pascalCase(parentHint) + base;
    if (parentHint && !used.has(prefixed)) {
      used.add(prefixed);
      return prefixed;
    }
    let n = 2;
    while (used.has(`${base}${n}`)) n++;
    used.add(`${base}${n}`);
    return `${base}${n}`;
  };

  const visit = (schema: Schema, preferred: string, parentHint: string): void => {
    const { schema: bare } = splitNullable(schema);

    switch (bare.kind) {
      case 'array':
        // An array named `users` should produce a `User`, not a `Users`.
        visit(bare.items, singularize(preferred), parentHint);
        return;

      case 'union':
        for (const option of bare.options) visit(option, preferred, parentHint);
        return;

      case 'object': {
        const key = schemaKey(bare);
        if (names.has(key)) return;

        // Reserve the name before descending so a self-similar nested shape
        // cannot steal it, then emit post-order for Zod's const ordering.
        const name = claim(preferred, parentHint);
        names.set(key, name);

        for (const [fieldName, field] of bare.fields) {
          visit(field.schema, fieldName, name);
        }

        types.push({ name, schema: bare });
        return;
      }

      default:
        return;
    }
  };

  const { schema: bareRoot } = splitNullable(root);
  const rootAlias = pascalCase(rootName) || 'Root';

  if (bareRoot.kind === 'array') {
    // A root array needs two names: the alias for the array itself, and one for
    // its element type. Letting both default to the root name emits
    // `type Root = Root[]`, which does not compile -- so the alias claims the
    // root name first and the element takes the singular (or `<Root>Item` when
    // singularising changes nothing).
    used.add(rootAlias);
    const singular = pascalCase(singularize(rootName));
    const elementName = singular && singular !== rootAlias ? singular : `${rootAlias}Item`;
    visit(bareRoot.items, elementName, '');
    return { types, names, rootName: rootAlias };
  }

  visit(root, rootName, '');

  return {
    types,
    names,
    rootName:
      bareRoot.kind === 'object'
        ? (names.get(schemaKey(bareRoot)) ?? rootAlias)
        : rootAlias,
  };
}
