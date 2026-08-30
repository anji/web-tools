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
import { emitGo } from './emit-go.js';
import { emitCSharp } from './emit-csharp.js';
import { emitPython } from './emit-python.js';
import { emitJava } from './emit-java.js';
import { emitRust } from './emit-rust.js';

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

const CORRECTNESS_FAQ = {
  question: 'Why does this produce different types than other converters?',
  answer:
    'Because every element of the array is merged before anything is generated. A converter that reads only the first record cannot know that a field is missing from later ones, or that it is sometimes null, so it emits a plain non-nullable type. In a statically typed language that is not a cosmetic difference: it is the line between a clean decode and a nil dereference at runtime.',
};

const goTool = defineTool({
  id: 'to-go',
  slug: 'json-to-go',
  label: 'JSON → Go',
  blurb: 'Generate Go structs with json tags, pointers for optional fields, and gofmt spacing.',
  category: 'Code generation',
  seo: {
    title: 'JSON to Go Struct Generator - Correct Pointers, gofmt Output',
    description:
      'Convert JSON to Go structs in your browser. Merges every array element so optional and null fields become pointers, applies Go initialism conventions (ID, URL, API), and emits gofmt-formatted output. No upload.',
    heading: 'JSON to Go',
    intro:
      'Paste a JSON response and get Go structs you can paste straight into a file. Fields that are optional or nullable become pointers, so you keep the difference between absent, null and the zero value.',
    keywords: [
      'json to go',
      'json to go struct',
      'go struct generator',
      'json to golang struct',
      'generate go types from json',
    ],
    faq: [
      PRIVACY_FAQ,
      SAMPLES_FAQ,
      CORRECTNESS_FAQ,
      {
        question: 'Why are some fields pointers?',
        answer:
          'Because a plain string cannot represent absence. If the API omits a field, or sends null, a string field silently decodes to "" and your code cannot tell that apart from an empty value the server really sent. A *string can. Only fields that were actually missing or null in your sample get one, so the output does not turn into pointers everywhere.',
      },
      {
        question: 'Why is it ID and not Id?',
        answer:
          'Go convention capitalises initialisms whole - ID, URL, API, HTTP, UUID - and linters flag the alternative. The generator applies the same list golint used, so an api_url key becomes APIURL rather than ApiUrl.',
      },
      {
        question: 'Do I need to run gofmt on the output?',
        answer:
          'No. The field name, type and tag columns are aligned exactly as gofmt would align them, which is checked against the real gofmt binary in this project\u2019s tests.',
      },
    ],
  },
  inputs: [JSON_INPUT] as const,
  options: [
    { kind: 'text', key: 'rootName', label: 'Root type name', default: 'Root', placeholder: 'Root' },
    { kind: 'text', key: 'packageName', label: 'Package', default: 'main', placeholder: 'main' },
    { kind: 'boolean', key: 'usePointers', label: 'Pointers for optional', default: true, help: 'Keeps absent and null distinguishable.' },
    { kind: 'boolean', key: 'omitempty', label: 'omitempty tags', default: true },
    {
      kind: 'select',
      key: 'intType',
      label: 'Integers',
      choices: [
        { value: 'int64', label: 'int64' },
        { value: 'int', label: 'int' },
      ],
      default: 'int64',
    },
    { kind: 'boolean', key: 'useTimeType', label: 'time.Time for timestamps', default: false },
    { kind: 'boolean', key: 'useAnyKeyword', label: 'any instead of interface{}', default: true, help: 'Go 1.18+' },
  ],
  run(inputs, options): Result<ToolOutput> {
    const parsed = parseJson(inputs[0] ?? '');
    if (!parsed.ok) return parsed;

    const result = emitGo(inferSchema(parsed.value), {
      rootName: readString(options, 'rootName', 'Root') || 'Root',
      packageName: readString(options, 'packageName', 'main'),
      usePointers: readBoolean(options, 'usePointers', true),
      omitempty: readBoolean(options, 'omitempty', true),
      intType: readString(options, 'intType', 'int64') === 'int' ? 'int' : 'int64',
      useTimeType: readBoolean(options, 'useTimeType', false),
      useAnyKeyword: readBoolean(options, 'useAnyKeyword', true),
    });

    return ok({
      content: result.code,
      language: 'text',
      filename: 'types.go',
      stats: [{ label: 'structs', value: String(result.typeCount) }],
      warnings: result.warnings,
    });
  },
});

const csharpTool = defineTool({
  id: 'to-csharp',
  slug: 'json-to-csharp',
  label: 'JSON → C#',
  blurb: 'Generate C# classes or records with nullable annotations and serializer attributes.',
  category: 'Code generation',
  seo: {
    title: 'JSON to C# Class Generator - Nullable-Aware, No Upload',
    description:
      'Convert JSON to C# classes or records in your browser. Merges every array element so optional and null fields get nullable annotations, adds System.Text.Json or Newtonsoft attributes, and maps UUIDs and timestamps to Guid and DateTime.',
    heading: 'JSON to C#',
    intro:
      'Paste a JSON response and get C# classes or records. Fields the payload can omit or send as null are annotated nullable, so the compiler warns you before a NullReferenceException does.',
    keywords: [
      'json to c#',
      'json to csharp class',
      'json to c# class generator',
      'convert json to c# model',
      'json to record c#',
    ],
    faq: [
      PRIVACY_FAQ,
      SAMPLES_FAQ,
      CORRECTNESS_FAQ,
      {
        question: 'Which serializer are the attributes for?',
        answer:
          'System.Text.Json by default, which is what modern .NET uses; switch to Newtonsoft if the project is on Json.NET, or turn attributes off entirely. The attribute preserves the original JSON key so the property can follow C# naming without breaking deserialisation.',
      },
      {
        question: 'What does "nullable reference types" change?',
        answer:
          'It emits string? rather than string for fields the payload can send as null. Without it the field still receives null at runtime - the compiler just stops warning you, which is how the exception ends up in production instead of in your editor.',
      },
      {
        question: 'Why was one of my properties renamed?',
        answer:
          'C# does not allow a member with the same name as its enclosing type, so a payload like {"user": {"user": ...}} would not compile. That property gets a suffix, and the serializer attribute still points at the original key.',
      },
    ],
  },
  inputs: [JSON_INPUT] as const,
  options: [
    { kind: 'text', key: 'rootName', label: 'Root type name', default: 'Root', placeholder: 'Root' },
    { kind: 'text', key: 'namespace', label: 'Namespace', default: '', placeholder: 'MyApp.Models' },
    {
      kind: 'select',
      key: 'style',
      label: 'Style',
      choices: [
        { value: 'class', label: 'class' },
        { value: 'record', label: 'record' },
      ],
      default: 'class',
    },
    {
      kind: 'select',
      key: 'serializer',
      label: 'Attributes',
      choices: [
        { value: 'system-text-json', label: 'System.Text.Json' },
        { value: 'newtonsoft', label: 'Newtonsoft.Json' },
        { value: 'none', label: 'None' },
      ],
      default: 'system-text-json',
    },
    { kind: 'boolean', key: 'nullableRefTypes', label: 'Nullable reference types', default: true },
    {
      kind: 'select',
      key: 'intType',
      label: 'Integers',
      choices: [
        { value: 'long', label: 'long' },
        { value: 'int', label: 'int' },
      ],
      default: 'long',
    },
    { kind: 'boolean', key: 'useRichTypes', label: 'Guid and DateTime', default: true },
  ],
  run(inputs, options): Result<ToolOutput> {
    const parsed = parseJson(inputs[0] ?? '');
    if (!parsed.ok) return parsed;

    const serializerRaw = readString(options, 'serializer', 'system-text-json');
    const result = emitCSharp(inferSchema(parsed.value), {
      rootName: readString(options, 'rootName', 'Root') || 'Root',
      namespace: readString(options, 'namespace', ''),
      style: readString(options, 'style', 'class') === 'record' ? 'record' : 'class',
      serializer:
        serializerRaw === 'newtonsoft' || serializerRaw === 'none'
          ? serializerRaw
          : 'system-text-json',
      nullableRefTypes: readBoolean(options, 'nullableRefTypes', true),
      intType: readString(options, 'intType', 'long') === 'int' ? 'int' : 'long',
      useRichTypes: readBoolean(options, 'useRichTypes', true),
    });

    return ok({
      content: result.code,
      language: 'text',
      filename: 'Models.cs',
      stats: [{ label: 'types', value: String(result.typeCount) }],
      warnings: result.warnings,
    });
  },
});

const pythonTool = defineTool({
  id: 'to-python',
  slug: 'json-to-python',
  label: 'JSON → Python',
  blurb: 'Generate Pydantic models or dataclasses, with aliases and correct field ordering.',
  category: 'Code generation',
  seo: {
    title: 'JSON to Python - Pydantic Models and Dataclasses, No Upload',
    description:
      'Convert JSON to Pydantic v2 models or Python dataclasses in your browser. Merges every array element for correct Optional types, snake_cases keys with aliases, and orders fields so dataclasses actually import.',
    heading: 'JSON to Python',
    intro:
      'Paste a JSON response and get Pydantic v2 models or plain dataclasses. Keys are converted to snake_case with the original preserved as an alias, and fields are ordered so the result imports without a TypeError.',
    keywords: [
      'json to python',
      'json to pydantic',
      'json to dataclass',
      'generate pydantic model from json',
      'json to python class',
    ],
    faq: [
      PRIVACY_FAQ,
      SAMPLES_FAQ,
      CORRECTNESS_FAQ,
      {
        question: 'Pydantic or dataclasses?',
        answer:
          'Pydantic if you are parsing JSON, because it validates the payload and applies the field aliases for you. Dataclasses if you only want a typed container and are decoding some other way - they are stdlib, with no dependency, but they do not map JSON keys or check types at all.',
      },
      {
        question: 'Why were my fields reordered?',
        answer:
          'A dataclass cannot declare a field with a default before one without; Python raises "non-default argument follows default argument" when the module is imported. Optional fields carry a None default, so they are emitted after the required ones. Knowing which fields are genuinely optional is what makes that possible.',
      },
      {
        question: 'What happened to my _id field?',
        answer:
          'It becomes id with alias="_id". Pydantic treats a leading underscore as a private attribute and rejects the model outright, so the Mongo-style key has to be renamed - the alias keeps parsing the original document unchanged.',
      },
    ],
  },
  inputs: [JSON_INPUT] as const,
  options: [
    { kind: 'text', key: 'rootName', label: 'Root type name', default: 'Root', placeholder: 'Root' },
    {
      kind: 'select',
      key: 'style',
      label: 'Style',
      choices: [
        { value: 'pydantic', label: 'Pydantic v2' },
        { value: 'dataclass', label: 'dataclass' },
      ],
      default: 'pydantic',
    },
    { kind: 'boolean', key: 'modernUnions', label: 'str | None', default: true, help: 'Off uses Optional[str]. Python 3.10+.' },
    { kind: 'boolean', key: 'snakeCaseFields', label: 'snake_case fields', default: true },
    { kind: 'boolean', key: 'useRichTypes', label: 'datetime, UUID, EmailStr', default: true },
  ],
  run(inputs, options): Result<ToolOutput> {
    const parsed = parseJson(inputs[0] ?? '');
    if (!parsed.ok) return parsed;

    const result = emitPython(inferSchema(parsed.value), {
      rootName: readString(options, 'rootName', 'Root') || 'Root',
      style: readString(options, 'style', 'pydantic') === 'dataclass' ? 'dataclass' : 'pydantic',
      modernUnions: readBoolean(options, 'modernUnions', true),
      useRichTypes: readBoolean(options, 'useRichTypes', true),
      snakeCaseFields: readBoolean(options, 'snakeCaseFields', true),
    });

    return ok({
      content: result.code,
      language: 'text',
      filename: 'models.py',
      stats: [{ label: 'models', value: String(result.typeCount) }],
      warnings: result.warnings,
    });
  },
});

const javaTool = defineTool({
  id: 'to-java',
  slug: 'json-to-java',
  label: 'JSON → Java',
  blurb: 'Generate Java records or POJOs with Jackson annotations and correctly boxed types.',
  category: 'Code generation',
  seo: {
    title: 'JSON to Java POJO and Record Generator - No Upload',
    description:
      'Convert JSON to Java records or POJOs in your browser. Merges every array element so optional fields are boxed rather than primitive, adds Jackson annotations, and maps timestamps and UUIDs to Instant and UUID.',
    heading: 'JSON to Java',
    intro:
      'Paste a JSON response and get Java records or classic POJOs with getters and setters. Fields the payload can omit or send as null come back boxed, because a Java primitive has no way to represent absence.',
    keywords: [
      'json to java',
      'json to pojo',
      'json to java class',
      'json to java record',
      'generate java class from json',
    ],
    faq: [
      PRIVACY_FAQ,
      SAMPLES_FAQ,
      CORRECTNESS_FAQ,
      {
        question: 'Why is one field long and another Long?',
        answer:
          'A primitive long cannot be null. If the API omits a field or sends null, a long silently stays 0 and your code cannot tell that apart from a zero the server really sent - so any field the sample showed as absent or null is boxed. Fields present in every record stay primitive, which is faster and clearer about intent.',
      },
      {
        question: 'Records or POJOs?',
        answer:
          'Records if you are on Java 16 or later and the data is immutable, which is usually true of a decoded response - they are a fraction of the code. POJOs if a framework requires a no-arg constructor and setters, which some older Jackson and JPA setups still do.',
      },
      {
        question: 'Why is each class shown as a separate file?',
        answer:
          'Java allows only one public top-level type per file, so concatenating them would not compile. Each block is headed with the filename it belongs in.',
      },
    ],
  },
  inputs: [JSON_INPUT] as const,
  options: [
    { kind: 'text', key: 'rootName', label: 'Root type name', default: 'Root', placeholder: 'Root' },
    { kind: 'text', key: 'packageName', label: 'Package', default: '', placeholder: 'com.example.models' },
    {
      kind: 'select',
      key: 'style',
      label: 'Style',
      choices: [
        { value: 'record', label: 'record (Java 16+)' },
        { value: 'class', label: 'POJO with getters' },
      ],
      default: 'record',
    },
    { kind: 'boolean', key: 'jackson', label: 'Jackson annotations', default: true },
    { kind: 'boolean', key: 'useBoxedTypes', label: 'Box nullable primitives', default: true, help: 'A primitive cannot hold null.' },
    { kind: 'boolean', key: 'useRichTypes', label: 'Instant and UUID', default: true },
  ],
  run(inputs, options): Result<ToolOutput> {
    const parsed = parseJson(inputs[0] ?? '');
    if (!parsed.ok) return parsed;

    const result = emitJava(inferSchema(parsed.value), {
      rootName: readString(options, 'rootName', 'Root') || 'Root',
      packageName: readString(options, 'packageName', ''),
      style: readString(options, 'style', 'record') === 'class' ? 'class' : 'record',
      jackson: readBoolean(options, 'jackson', true),
      useBoxedTypes: readBoolean(options, 'useBoxedTypes', true),
      useRichTypes: readBoolean(options, 'useRichTypes', true),
    });

    return ok({
      content: result.code,
      language: 'text',
      filename: 'Models.java',
      stats: [{ label: 'types', value: String(result.typeCount) }],
      warnings: result.warnings,
    });
  },
});

const rustTool = defineTool({
  id: 'to-rust',
  slug: 'json-to-rust',
  label: 'JSON → Rust',
  blurb: 'Generate serde structs with Option, rename attributes and rustfmt spacing.',
  category: 'Code generation',
  seo: {
    title: 'JSON to Rust Serde Struct Generator - Runs In Your Browser',
    description:
      'Convert JSON to Rust structs with serde derives. Merges every array element so optional fields become Option<T>, renames keys to snake_case with serde rename, and emits rustfmt-clean output. No upload.',
    heading: 'JSON to Rust',
    intro:
      'Paste a JSON response and get serde-ready Rust structs. Fields the payload can omit or send as null become Option<T> - in Rust that is not a style choice, it is the difference between deserialising and erroring out.',
    keywords: [
      'json to rust',
      'json to serde struct',
      'rust struct generator',
      'json to rust struct',
      'generate serde types from json',
    ],
    faq: [
      PRIVACY_FAQ,
      SAMPLES_FAQ,
      CORRECTNESS_FAQ,
      {
        question: 'Why does it matter more in Rust?',
        answer:
          'Rust has no null. A String field cannot hold one, so if the payload sends null serde fails the entire deserialisation with a type error rather than filling in a default. A converter that guesses from one record produces types that simply do not parse the second record.',
      },
      {
        question: 'What is r#type?',
        answer:
          'A raw identifier. Some JSON keys - type, match, use - are Rust keywords, and the r# prefix lets them be used as field names without renaming. A handful of keywords cannot be expressed that way, and those get a suffix plus a serde rename instead.',
      },
      {
        question: 'Do I need to run rustfmt on this?',
        answer:
          'No. The output is checked against the real rustfmt binary in this project\u2019s tests, so it is already formatted the way your project would format it.',
      },
    ],
  },
  inputs: [JSON_INPUT] as const,
  options: [
    { kind: 'text', key: 'rootName', label: 'Root type name', default: 'Root', placeholder: 'Root' },
    { kind: 'text', key: 'derives', label: 'Extra derives', default: 'Debug, Clone', placeholder: 'Debug, Clone' },
    { kind: 'boolean', key: 'useOption', label: 'Option for optional', default: true, help: 'Rust has no null.' },
    { kind: 'boolean', key: 'skipSerializingNone', label: 'skip_serializing_if on None', default: true },
    { kind: 'boolean', key: 'useRichTypes', label: 'chrono and uuid types', default: false, help: 'Needs those crates.' },
    { kind: 'boolean', key: 'publicItems', label: 'pub structs and fields', default: true },
  ],
  run(inputs, options): Result<ToolOutput> {
    const parsed = parseJson(inputs[0] ?? '');
    if (!parsed.ok) return parsed;

    const result = emitRust(inferSchema(parsed.value), {
      rootName: readString(options, 'rootName', 'Root') || 'Root',
      derives: readString(options, 'derives', 'Debug, Clone'),
      useOption: readBoolean(options, 'useOption', true),
      skipSerializingNone: readBoolean(options, 'skipSerializingNone', true),
      useRichTypes: readBoolean(options, 'useRichTypes', false),
      publicItems: readBoolean(options, 'publicItems', true),
    });

    return ok({
      content: result.code,
      language: 'text',
      filename: 'models.rs',
      stats: [{ label: 'structs', value: String(result.typeCount) }],
      warnings: result.warnings,
    });
  },
});

export const codegenTools = [
  typescriptTool,
  zodTool,
  jsonSchemaTool,
  goTool,
  csharpTool,
  pythonTool,
  javaTool,
  rustTool,
];
