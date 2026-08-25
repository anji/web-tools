import {
  defineTool,
  ok,
  readBoolean,
  readNumber,
  readString,
  type Result,
  type ToolOutput,
} from '@tools/core';

import { parseJson } from './parse.js';
import { jsonToCsv } from './to-csv.js';
import { jsonToYaml, yamlToJson } from './yaml.js';
import { flattenValue, unflattenValue } from './flatten.js';
import { formatJson } from './format.js';

const JSON_INPUT = {
  label: 'JSON',
  placeholder: '[\n  { "id": 1, "name": "Ada", "team": { "name": "Core" } },\n  { "id": 2, "name": "Grace", "team": { "name": "Compilers" } }\n]',
  language: 'json' as const,
  accept: ['.json', '.txt'] as const,
};

const PRIVACY_FAQ = {
  question: 'Is my data uploaded anywhere?',
  answer:
    'No. The conversion is a pure function running in your browser tab. Nothing is transmitted, which is what makes it safe for production exports.',
};

const csvTool = defineTool({
  id: 'to-csv',
  slug: 'json-to-csv',
  label: 'JSON → CSV',
  blurb: 'Flatten nested records into a spreadsheet, with the column union taken across every row.',
  category: 'Convert',
  seo: {
    title: 'JSON to CSV Converter - Handles Nested Objects, No Upload',
    description:
      'Convert JSON to CSV in your browser. Flattens nested objects into dotted columns, takes the column union across all rows, and handles Excel quoting and BOM. Nothing uploaded.',
    heading: 'JSON to CSV',
    intro:
      'Turn an array of JSON records into a spreadsheet. Nested objects are flattened into dotted column names, and the header is the union of every record’s keys - so rows that omit a field still line up.',
    keywords: ['json to csv', 'convert json to csv', 'json to excel', 'nested json to csv', 'json array to csv'],
    faq: [
      PRIVACY_FAQ,
      {
        question: 'What happens to nested objects and arrays?',
        answer:
          'Objects become dotted columns such as team.name. Arrays become indexed columns such as tags[0], tags[1], or a single JSON-encoded cell if you turn on "Arrays as JSON" - which is usually what you want when the array length varies per row.',
      },
      {
        question: 'My export opens with broken accents in Excel.',
        answer:
          'Turn on "UTF-8 BOM". Excel assumes the legacy code page unless the file starts with a byte order mark, which mangles any non-ASCII text.',
      },
      {
        question: 'My JSON is wrapped in a { "data": [...] } envelope.',
        answer:
          'That is handled. When the top level is a small object containing exactly one array, that array is used as the row source and the tool tells you which key it picked.',
      },
    ],
  },
  inputs: [JSON_INPUT] as const,
  options: [
    {
      kind: 'select',
      key: 'delimiter',
      label: 'Delimiter',
      choices: [
        { value: ',', label: 'Comma' },
        { value: ';', label: 'Semicolon' },
        { value: '\t', label: 'Tab' },
        { value: '|', label: 'Pipe' },
      ],
      default: ',',
    },
    { kind: 'boolean', key: 'header', label: 'Header row', default: true },
    { kind: 'boolean', key: 'arraysAsJson', label: 'Arrays as JSON', default: false, help: 'One cell per array instead of one column per element.' },
    { kind: 'boolean', key: 'quoteAll', label: 'Quote every field', default: false },
    { kind: 'boolean', key: 'crlf', label: 'CRLF line endings', default: false, help: 'Excel prefers CRLF.' },
    { kind: 'boolean', key: 'bom', label: 'UTF-8 BOM', default: false, help: 'Fixes accented characters in Excel.' },
    { kind: 'number', key: 'maxDepth', label: 'Max flatten depth', default: 12, min: 1, max: 40, step: 1 },
  ],
  run(inputs, options): Result<ToolOutput> {
    const parsed = parseJson(inputs[0] ?? '');
    if (!parsed.ok) return parsed;

    const result = jsonToCsv(parsed.value, {
      separator: '.',
      bracketArrays: true,
      maxDepth: readNumber(options, 'maxDepth', 12),
      arraysAsJson: readBoolean(options, 'arraysAsJson', false),
      delimiter: readString(options, 'delimiter', ','),
      header: readBoolean(options, 'header', true),
      quoteAll: readBoolean(options, 'quoteAll', false),
      newline: readBoolean(options, 'crlf', false) ? '\r\n' : '\n',
      bom: readBoolean(options, 'bom', false),
    });

    return ok({
      content: result.csv,
      language: 'csv',
      filename: 'data.csv',
      stats: [
        { label: 'rows', value: result.rows.toLocaleString() },
        { label: 'columns', value: String(result.columns.length) },
      ],
      warnings: result.warnings,
    });
  },
});

const toYamlTool = defineTool({
  id: 'to-yaml',
  slug: 'json-to-yaml',
  label: 'JSON → YAML',
  blurb: 'Convert JSON to YAML for Kubernetes manifests, CI configs and Compose files.',
  category: 'Convert',
  seo: {
    title: 'JSON to YAML Converter - Private, In-Browser, No Sign-Up',
    description:
      'Convert JSON to YAML online without uploading anything. Configurable indentation and line width, ideal for Kubernetes manifests, GitHub Actions and Docker Compose files.',
    heading: 'JSON to YAML',
    intro:
      'Convert a JSON document to YAML. Handy when an API hands you JSON but the thing you are configuring - Kubernetes, GitHub Actions, Compose - wants YAML.',
    keywords: ['json to yaml', 'convert json to yaml', 'json to yaml converter', 'json to kubernetes yaml'],
    faq: [
      PRIVACY_FAQ,
      {
        question: 'Why is my long string being wrapped?',
        answer:
          'YAML folds long scalars by default. The line width option defaults to 0 here, which disables folding - that is almost always what you want for config files that a human will read in a diff.',
      },
    ],
  },
  inputs: [JSON_INPUT] as const,
  options: [
    { kind: 'number', key: 'indent', label: 'Indent', default: 2, min: 1, max: 8, step: 1 },
    { kind: 'boolean', key: 'documentStart', label: 'Leading ---', default: false },
    { kind: 'boolean', key: 'quoteStrings', label: 'Quote all strings', default: false },
    { kind: 'number', key: 'lineWidth', label: 'Line width (0 = no wrap)', default: 0, min: 0, max: 200, step: 10 },
  ],
  run(inputs, options): Result<ToolOutput> {
    const parsed = parseJson(inputs[0] ?? '');
    if (!parsed.ok) return parsed;

    const yaml = jsonToYaml(parsed.value, {
      indent: readNumber(options, 'indent', 2),
      lineWidth: readNumber(options, 'lineWidth', 0),
      documentStart: readBoolean(options, 'documentStart', false),
      quoteStrings: readBoolean(options, 'quoteStrings', false),
    });
    if (!yaml.ok) return yaml;

    return ok({
      content: yaml.value,
      language: 'yaml',
      filename: 'output.yaml',
      stats: [{ label: 'lines', value: String(yaml.value.split('\n').length) }],
    });
  },
});

const fromYamlTool = defineTool({
  id: 'from-yaml',
  slug: 'yaml-to-json',
  label: 'YAML → JSON',
  blurb: 'Parse YAML into JSON, with the failing line and column when it will not parse.',
  category: 'Convert',
  seo: {
    title: 'YAML to JSON Converter - Runs Locally In Your Browser',
    description:
      'Convert YAML to JSON without uploading anything. Reports the exact line and column when the YAML is invalid. Works with Kubernetes manifests and CI configuration.',
    heading: 'YAML to JSON',
    intro:
      'Paste YAML and get JSON back. When the YAML is malformed you get the line and column rather than a stack trace - usually it is tabs where spaces were expected.',
    keywords: ['yaml to json', 'convert yaml to json', 'yaml parser online', 'yaml to json converter'],
    faq: [
      PRIVACY_FAQ,
      {
        question: 'Why does my YAML fail to parse?',
        answer:
          'The usual cause is a literal tab character. YAML forbids tabs for indentation, and most editors will happily insert one. Mixed indentation levels inside the same block are the other common cause.',
      },
    ],
  },
  inputs: [
    {
      label: 'YAML',
      placeholder: 'name: ada\nroles:\n  - admin\n  - editor\n',
      language: 'yaml' as const,
      accept: ['.yaml', '.yml', '.txt'] as const,
    },
  ] as const,
  options: [
    {
      kind: 'select',
      key: 'indent',
      label: 'Indent',
      choices: [
        { value: '2', label: '2 spaces' },
        { value: '4', label: '4 spaces' },
        { value: '0', label: 'Minified' },
      ],
      default: '2',
    },
    { kind: 'boolean', key: 'sortKeys', label: 'Sort keys', default: false },
  ],
  run(inputs, options): Result<ToolOutput> {
    const parsed = yamlToJson(inputs[0] ?? '');
    if (!parsed.ok) return parsed;

    const indent = Number(readString(options, 'indent', '2'));
    const content = formatJson(parsed.value, {
      indent: indent === 0 ? 2 : indent,
      sortKeys: readBoolean(options, 'sortKeys', false),
      minify: indent === 0,
    });

    return ok({ content, language: 'json', filename: 'output.json' });
  },
});

const flattenTool = defineTool({
  id: 'flatten',
  slug: 'json-flatten',
  label: 'Flatten / unflatten',
  blurb: 'Collapse nested JSON to dotted paths, or rebuild the nesting from them.',
  category: 'Convert',
  seo: {
    title: 'Flatten JSON Online - Nested JSON to Dot Notation, No Upload',
    description:
      'Flatten nested JSON into dot-notation key paths, or unflatten dotted keys back into nested objects. Runs entirely in your browser with nothing uploaded.',
    heading: 'Flatten & Unflatten JSON',
    intro:
      'Collapse a deeply nested document into flat dot-notation keys - the shape that i18n files, feature flag stores and environment configs usually want - or reverse the process.',
    keywords: ['flatten json', 'json flattener', 'nested json to flat', 'unflatten json', 'json dot notation'],
    faq: [
      PRIVACY_FAQ,
      {
        question: 'How are array elements represented?',
        answer:
          'As bracketed indices by default, so items[0].name. Switch to dotted indices if the consumer on the other end expects items.0.name, which some i18n libraries do.',
      },
      {
        question: 'Does unflatten reverse flatten exactly?',
        answer:
          'For the common cases, yes. It is not a perfect round trip when your original keys themselves contain the separator character - a key literally called "a.b" is indistinguishable from nesting once flattened.',
      },
    ],
  },
  inputs: [JSON_INPUT] as const,
  options: [
    {
      kind: 'select',
      key: 'direction',
      label: 'Direction',
      choices: [
        { value: 'flatten', label: 'Flatten' },
        { value: 'unflatten', label: 'Unflatten' },
      ],
      default: 'flatten',
    },
    { kind: 'text', key: 'separator', label: 'Separator', default: '.', placeholder: '.' },
    { kind: 'boolean', key: 'bracketArrays', label: 'Bracketed array indices', default: true, help: 'items[0] rather than items.0' },
    { kind: 'number', key: 'maxDepth', label: 'Max depth', default: 12, min: 1, max: 40, step: 1 },
  ],
  run(inputs, options): Result<ToolOutput> {
    const parsed = parseJson(inputs[0] ?? '');
    if (!parsed.ok) return parsed;

    const separator = readString(options, 'separator', '.') || '.';
    const flattening = readString(options, 'direction', 'flatten') !== 'unflatten';

    if (!flattening) {
      const source = parsed.value;
      if (source === null || typeof source !== 'object' || Array.isArray(source)) {
        return {
          ok: false,
          error: {
            message: 'Unflatten needs a flat object of path -> value pairs.',
            hint: 'The input should look like {"user.name": "Ada", "user.id": 1}.',
          },
        };
      }
      const rebuilt = unflattenValue(source as Record<string, unknown>, separator);
      return ok({
        content: formatJson(rebuilt, { indent: 2, sortKeys: false, minify: false }),
        language: 'json',
        filename: 'unflattened.json',
      });
    }

    const flat = flattenValue(parsed.value, {
      separator,
      bracketArrays: readBoolean(options, 'bracketArrays', true),
      maxDepth: readNumber(options, 'maxDepth', 12),
      arraysAsJson: false,
    });

    return ok({
      content: formatJson(flat, { indent: 2, sortKeys: false, minify: false }),
      language: 'json',
      filename: 'flattened.json',
      stats: [{ label: 'keys', value: String(Object.keys(flat).length) }],
    });
  },
});

export const dataTools = [csvTool, toYamlTool, fromYamlTool, flattenTool];
