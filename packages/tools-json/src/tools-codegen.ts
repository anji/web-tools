import {
  defineTool,
  ok,
  readBoolean,
  readString,
  type Result,
  type ToolOutput,
} from '@tools/core';

import { parseJson } from './parse.js';
import { inferSchema } from './schema.js';
import { emitTypeScript } from './emit-typescript.js';
import { emitZod } from './emit-zod.js';
import { emitJsonSchema } from './emit-json-schema.js';

const JSON_INPUT = {
  label: 'JSON',
  placeholder:
    '{\n  "id": 1,\n  "name": "Ada Lovelace",\n  "email": "ada@example.com",\n  "roles": ["admin", "editor"],\n  "profile": { "bio": null, "joinedAt": "1843-10-01T00:00:00Z" }\n}',
  language: 'json' as const,
  accept: ['.json', '.txt'] as const,
};

const PRIVACY_FAQ = {
  question: 'Is my JSON uploaded anywhere?',
  answer:
    'No. Inference and code generation run entirely in your browser. Nothing is sent to a server, so pasting a real API response with customer data or internal URLs is safe.',
};

const SAMPLES_FAQ = {
  question: 'Should I paste one object or an array of them?',
  answer:
    'An array, whenever you have one. Every element is merged into a single shape, so a field that is missing from some records becomes optional and a field that is sometimes null becomes nullable. One object can only ever tell the generator that everything is required.',
};

const typescriptTool = defineTool({
  id: 'to-typescript',
  slug: 'json-to-typescript',
  label: 'JSON → TypeScript',
  blurb: 'Generate named interfaces, with optionals and nullability inferred from every sample.',
  category: 'Code generation',
  seo: {
    title: 'JSON to TypeScript - Generate Interfaces Online, No Upload',
    description:
      'Convert JSON to TypeScript interfaces in your browser. Merges every array element to infer optional and nullable fields, names nested types, and detects enums. Nothing uploaded.',
    heading: 'JSON to TypeScript',
    intro:
      'Paste a JSON response and get clean, named TypeScript interfaces. Every element of an array is merged, so fields that only appear on some records come out optional rather than silently wrong.',
    keywords: [
      'json to typescript',
      'json to interface',
      'generate typescript types from json',
      'json to ts',
      'api response to typescript',
    ],
    faq: [
      PRIVACY_FAQ,
      SAMPLES_FAQ,
      {
        question: 'How are nested types named?',
        answer:
          'From the key that contains them, in PascalCase, with array keys singularised - a "users" array of objects produces a "User" interface. Structurally identical shapes collapse onto one type instead of generating dozens of duplicates.',
      },
      {
        question: 'Why did a string field become a union of literals?',
        answer:
          'Because the value looked like an enum: a small set of distinct values, each seen more than once. Turn off "Infer literal unions" to always emit plain string.',
      },
    ],
  },
  inputs: [JSON_INPUT] as const,
  options: [
    { kind: 'text', key: 'rootName', label: 'Root type name', default: 'Root', placeholder: 'Root' },
    { kind: 'boolean', key: 'useInterfaces', label: 'Use interface', default: true, help: 'Off emits type aliases instead.' },
    { kind: 'boolean', key: 'readonlyFields', label: 'readonly fields', default: false },
    { kind: 'boolean', key: 'inferLiteralUnions', label: 'Infer literal unions', default: true, help: 'Turn repeated string sets into unions.' },
    { kind: 'boolean', key: 'exported', label: 'export declarations', default: true },
  ],
  run(inputs, options): Result<ToolOutput> {
    const parsed = parseJson(inputs[0] ?? '');
    if (!parsed.ok) return parsed;

    const result = emitTypeScript(inferSchema(parsed.value), {
      rootName: readString(options, 'rootName', 'Root') || 'Root',
      useInterfaces: readBoolean(options, 'useInterfaces', true),
      readonlyFields: readBoolean(options, 'readonlyFields', false),
      optionalStyle: 'question',
      inferLiteralUnions: readBoolean(options, 'inferLiteralUnions', true),
      exported: readBoolean(options, 'exported', true),
    });

    return ok({
      content: result.code,
      language: 'typescript',
      filename: 'types.ts',
      stats: [{ label: 'types', value: String(result.typeCount) }],
      warnings: result.warnings,
    });
  },
});

const zodTool = defineTool({
  id: 'to-zod',
  slug: 'json-to-zod',
  label: 'JSON → Zod',
  blurb: 'Generate a Zod schema, with formats, enums and optionals already applied.',
  category: 'Code generation',
  seo: {
    title: 'JSON to Zod Schema Generator - Runs In Your Browser',
    description:
      'Turn JSON into a Zod schema online. Infers optional and nullable fields, applies z.email()/z.uuid()/z.iso.datetime(), detects enums, and emits z.infer types. No upload.',
    heading: 'JSON to Zod',
    intro:
      'Paste JSON and get a Zod schema you can drop straight into a project, including the inferred TypeScript type. Detected formats become real validators rather than bare z.string().',
    keywords: ['json to zod', 'zod schema generator', 'generate zod from json', 'json to zod schema online'],
    faq: [
      PRIVACY_FAQ,
      SAMPLES_FAQ,
      {
        question: 'Does it target Zod 3 or Zod 4?',
        answer:
          'Both - pick your version in the options. Zod 4 promoted the string formats to top-level schemas (z.email(), z.uuid(), z.iso.datetime()), while Zod 3 uses the chained z.string().email() form. The generator emits whichever your project is on.',
      },
      {
        question: 'Why is a field .optional() rather than .nullable()?',
        answer:
          'They mean different things and the generator distinguishes them. A key absent from some samples becomes .optional(); a key present but sometimes null becomes .nullable(). A key that is both gets both.',
      },
    ],
  },
  inputs: [JSON_INPUT] as const,
  options: [
    { kind: 'text', key: 'rootName', label: 'Root type name', default: 'Root', placeholder: 'Root' },
    {
      kind: 'select',
      key: 'version',
      label: 'Zod version',
      choices: [
        { value: 'v4', label: 'Zod 4' },
        { value: 'v3', label: 'Zod 3' },
      ],
      default: 'v4',
    },
    { kind: 'boolean', key: 'applyFormats', label: 'Apply format validators', default: true, help: 'email, uuid, url, datetime.' },
    { kind: 'boolean', key: 'inferLiteralUnions', label: 'Detect enums', default: true },
    { kind: 'boolean', key: 'inferTypes', label: 'Emit z.infer types', default: true },
  ],
  run(inputs, options): Result<ToolOutput> {
    const parsed = parseJson(inputs[0] ?? '');
    if (!parsed.ok) return parsed;

    const result = emitZod(inferSchema(parsed.value), {
      rootName: readString(options, 'rootName', 'Root') || 'Root',
      version: readString(options, 'version', 'v4') === 'v3' ? 'v3' : 'v4',
      inferTypes: readBoolean(options, 'inferTypes', true),
      applyFormats: readBoolean(options, 'applyFormats', true),
      inferLiteralUnions: readBoolean(options, 'inferLiteralUnions', true),
      schemaSuffix: 'Schema',
    });

    return ok({
      content: result.code,
      language: 'typescript',
      filename: 'schema.ts',
      stats: [{ label: 'schemas', value: String(result.typeCount) }],
      warnings: result.warnings,
    });
  },
});

const jsonSchemaTool = defineTool({
  id: 'to-json-schema',
  slug: 'json-to-json-schema',
  label: 'JSON → JSON Schema',
  blurb: 'Generate a draft 2020-12 or draft-07 schema with $defs and required arrays.',
  category: 'Code generation',
  seo: {
    title: 'JSON to JSON Schema Generator - Draft 2020-12 and Draft-07',
    description:
      'Generate a JSON Schema from a sample document, in your browser. Hoists repeated shapes into $defs, infers required fields from multiple samples, and applies string formats.',
    heading: 'JSON to JSON Schema',
    intro:
      'Turn a sample document into a JSON Schema. Repeated object shapes are hoisted into $defs and referenced, so the output stays readable even for a large response.',
    keywords: [
      'json to json schema',
      'json schema generator',
      'generate json schema from json',
      'json schema draft 2020-12 generator',
    ],
    faq: [
      PRIVACY_FAQ,
      SAMPLES_FAQ,
      {
        question: 'Should I set additionalProperties to false?',
        answer:
          'Usually not. It rejects any field that was not in your sample, which means the schema breaks the first time the API adds one. Turn it on only when you genuinely control both ends and want a closed contract.',
      },
      {
        question: 'Which draft should I pick?',
        answer:
          'Draft 2020-12 unless a tool in your pipeline requires otherwise. It uses $defs; draft-07 uses definitions, and expresses nullable references as an anyOf composition because a $ref cannot carry sibling keywords.',
      },
    ],
  },
  inputs: [JSON_INPUT] as const,
  options: [
    { kind: 'text', key: 'rootName', label: 'Title', default: 'Root', placeholder: 'Root' },
    {
      kind: 'select',
      key: 'draft',
      label: 'Draft',
      choices: [
        { value: '2020-12', label: 'Draft 2020-12' },
        { value: 'draft-07', label: 'Draft-07' },
      ],
      default: '2020-12',
    },
    { kind: 'boolean', key: 'useDefs', label: 'Hoist into $defs', default: true },
    { kind: 'boolean', key: 'markRequired', label: 'Emit required', default: true },
    { kind: 'boolean', key: 'closed', label: 'additionalProperties: false', default: false },
  ],
  run(inputs, options): Result<ToolOutput> {
    const parsed = parseJson(inputs[0] ?? '');
    if (!parsed.ok) return parsed;

    const result = emitJsonSchema(inferSchema(parsed.value), {
      rootName: readString(options, 'rootName', 'Root') || 'Root',
      draft: readString(options, 'draft', '2020-12') === 'draft-07' ? 'draft-07' : '2020-12',
      useDefs: readBoolean(options, 'useDefs', true),
      markRequired: readBoolean(options, 'markRequired', true),
      closed: readBoolean(options, 'closed', false),
      applyFormats: true,
      inferLiteralUnions: true,
    });

    return ok({
      content: result.code,
      language: 'json',
      filename: 'schema.json',
      stats: [{ label: '$defs', value: String(result.typeCount) }],
      warnings: result.warnings,
    });
  },
});

export const codegenTools = [typescriptTool, zodTool, jsonSchemaTool];
