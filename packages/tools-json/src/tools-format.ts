import {
  defineTool,
  ok,
  readBoolean,
  readString,
  type ToolOutput,
  type Result,
} from '@tools/core';

import { parseJson, measure } from './parse.js';
import { formatJson } from './format.js';

const bytes = (text: string): number => new TextEncoder().encode(text).length;

const sizeStat = (label: string, text: string) => ({
  label,
  value: bytes(text) < 1024 ? `${bytes(text)} B` : `${(bytes(text) / 1024).toFixed(1)} KB`,
});

const JSON_INPUT = {
  label: 'JSON',
  placeholder: '{\n  "id": 1,\n  "name": "Ada Lovelace"\n}',
  language: 'json' as const,
  accept: ['.json', '.txt'] as const,
};

/** Shared preamble: every tool page repeats the promise, because every tool page is a landing page. */
const PRIVACY_FAQ = {
  question: 'Is my JSON uploaded anywhere?',
  answer:
    'No. The conversion runs in your browser as a pure JavaScript function. There is no upload, no account, and no server-side processing, so you can safely paste production API responses.',
};

// ---------------------------------------------------------------------------
// Format / validate / minify
// ---------------------------------------------------------------------------

const formatTool = defineTool({
  id: 'format',
  slug: 'json-formatter',
  label: 'Formatter',
  blurb: 'Pretty-print, validate and sort JSON, with error messages that tell you what to fix.',
  category: 'Format',
  seo: {
    title: 'JSON Formatter and Validator - No Upload, No Sign-Up',
    description:
      'Format, validate and beautify JSON in your browser. Precise error locations, plain-English fixes for trailing commas and single quotes. Nothing is uploaded.',
    heading: 'JSON Formatter & Validator',
    intro:
      'Paste messy JSON and get it back readable. When it will not parse, you get the line, the column and an explanation of what is actually wrong - not just "Unexpected token".',
    keywords: ['json formatter', 'json validator', 'json beautifier', 'format json online', 'json pretty print'],
    faq: [
      PRIVACY_FAQ,
      {
        question: 'Why does my JSON say "Unexpected token }"?',
        answer:
          'Almost always a trailing comma before the closing bracket. JSON, unlike JavaScript and unlike most linters people are used to, does not allow one. This formatter detects that case and says so directly.',
      },
      {
        question: 'Can it sort object keys?',
        answer:
          'Yes. Turn on "Sort keys" to alphabetise every object recursively, which makes two responses far easier to compare by eye.',
      },
    ],
  },
  inputs: [JSON_INPUT] as const,
  options: [
    {
      kind: 'select',
      key: 'indent',
      label: 'Indent',
      choices: [
        { value: '2', label: '2 spaces' },
        { value: '4', label: '4 spaces' },
        { value: 'tab', label: 'Tabs' },
      ],
      default: '2',
    },
    { kind: 'boolean', key: 'sortKeys', label: 'Sort keys', default: false, help: 'Alphabetise keys recursively.' },
  ],
  run(inputs, options): Result<ToolOutput> {
    const source = inputs[0] ?? '';
    const parsed = parseJson(source);
    if (!parsed.ok) return parsed;

    const indentRaw = readString(options, 'indent', '2');
    const content = formatJson(parsed.value, {
      indent: indentRaw === 'tab' ? 'tab' : Number(indentRaw),
      sortKeys: readBoolean(options, 'sortKeys', false),
      minify: false,
    });

    const { nodes, depth, keys } = measure(parsed.value);
    return ok({
      content,
      language: 'json',
      filename: 'formatted.json',
      stats: [
        { label: 'valid', value: 'yes' },
        { label: 'keys', value: keys.toLocaleString() },
        { label: 'nodes', value: nodes.toLocaleString() },
        { label: 'depth', value: String(depth) },
        sizeStat('size', content),
      ],
    });
  },
});

const minifyTool = defineTool({
  id: 'minify',
  slug: 'json-minifier',
  label: 'Minifier',
  blurb: 'Strip every byte of whitespace and see exactly how much you saved.',
  category: 'Format',
  seo: {
    title: 'JSON Minifier - Compress JSON Online, Nothing Uploaded',
    description:
      'Minify JSON in your browser. Removes all whitespace, reports the exact byte saving, and optionally sorts keys. No upload, no sign-up.',
    heading: 'JSON Minifier',
    intro:
      'Strip the whitespace out of a JSON document and see the byte-for-byte saving. Useful before shipping a config, embedding a payload, or checking whether a response really needs gzip.',
    keywords: ['json minifier', 'minify json', 'compress json', 'json compressor online'],
    faq: [
      PRIVACY_FAQ,
      {
        question: 'Does minifying JSON change its meaning?',
        answer:
          'No. Whitespace between tokens is insignificant in JSON, so the minified document parses to exactly the same value. Key order is preserved unless you turn on sorting.',
      },
    ],
  },
  inputs: [JSON_INPUT] as const,
  options: [
    { kind: 'boolean', key: 'sortKeys', label: 'Sort keys', default: false },
  ],
  run(inputs, options): Result<ToolOutput> {
    const source = inputs[0] ?? '';
    const parsed = parseJson(source);
    if (!parsed.ok) return parsed;

    const content = formatJson(parsed.value, {
      indent: 2,
      sortKeys: readBoolean(options, 'sortKeys', false),
      minify: true,
    });

    const before = bytes(source);
    const after = bytes(content);
    const saved = before > 0 ? Math.round(((before - after) / before) * 100) : 0;

    return ok({
      content,
      language: 'json',
      filename: 'minified.json',
      stats: [
        sizeStat('before', source),
        sizeStat('after', content),
        { label: 'saved', value: `${saved}%` },
      ],
    });
  },
});

export const formatTools = [formatTool, minifyTool];
