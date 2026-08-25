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
import { diffJson, renderDiff } from './diff.js';
import { queryJsonPath } from './jsonpath.js';
import { redactJson, renderFindings, type RedactStyle } from './redact.js';
import { formatJson } from './format.js';

const PRIVACY_FAQ = {
  question: 'Is my JSON uploaded anywhere?',
  answer:
    'No. Everything runs inside your browser tab as plain JavaScript. There is no request to a server at any point, which is the entire reason this tool can be pointed at production data.',
};

const diffTool = defineTool({
  id: 'diff',
  slug: 'json-diff',
  label: 'JSON diff',
  blurb: 'Compare two documents structurally, so reordered keys stop showing up as changes.',
  category: 'Inspect',
  seo: {
    title: 'JSON Diff - Compare Two JSON Files Structurally, No Upload',
    description:
      'Compare two JSON documents in your browser. Structural comparison ignores key order and formatting, reports added, removed and changed paths, and can match array items by id.',
    heading: 'JSON Diff',
    intro:
      'Compare two JSON documents and get a list of what actually changed, by path. Because the comparison is structural rather than textual, reordered keys and different indentation do not show up as differences.',
    keywords: ['json diff', 'compare json', 'json compare online', 'diff two json files', 'api response diff'],
    faq: [
      PRIVACY_FAQ,
      {
        question: 'Why not just use a text diff?',
        answer:
          'Because a text diff on two pretty-printed API responses is mostly noise. Key order is insignificant in JSON but a text diff reports it as a change, and a single added field can reindent an entire block. Comparing parsed values removes both problems.',
      },
      {
        question: 'My arrays reordered and everything shows as changed.',
        answer:
          'Switch the array strategy to "match by id". Elements are then paired on their id field rather than their position, so a reordered list shows no changes and a genuinely modified element shows exactly which of its fields moved.',
      },
    ],
  },
  inputs: [
    {
      label: 'Before',
      placeholder: '{\n  "name": "Ada",\n  "role": "admin"\n}',
      language: 'json' as const,
      accept: ['.json', '.txt'] as const,
    },
    {
      label: 'After',
      placeholder: '{\n  "name": "Ada",\n  "role": "owner",\n  "email": "ada@example.com"\n}',
      language: 'json' as const,
      accept: ['.json', '.txt'] as const,
    },
  ] as const,
  options: [
    {
      kind: 'select',
      key: 'arrayStrategy',
      label: 'Arrays',
      choices: [
        { value: 'index', label: 'Compare by position' },
        { value: 'id', label: 'Match by id' },
        { value: 'set', label: 'Ignore order' },
      ],
      default: 'index',
    },
    { kind: 'text', key: 'idKey', label: 'Id field', default: 'id', placeholder: 'id' },
  ],
  run(inputs, options): Result<ToolOutput> {
    const before = parseJson(inputs[0] ?? '');
    if (!before.ok) {
      return { ok: false, error: { ...before.error, message: `Before: ${before.error.message}` } };
    }
    const after = parseJson(inputs[1] ?? '');
    if (!after.ok) {
      return { ok: false, error: { ...after.error, message: `After: ${after.error.message}` } };
    }

    const strategy = readString(options, 'arrayStrategy', 'index');
    const changes = diffJson(before.value, after.value, {
      arrayStrategy: strategy === 'id' ? 'id' : 'index',
      idKey: readString(options, 'idKey', 'id') || 'id',
      ignoreArrayOrder: strategy === 'set',
    });

    const counts = { added: 0, removed: 0, changed: 0 };
    for (const c of changes) counts[c.kind]++;

    return ok({
      content: renderDiff(changes),
      language: 'diff',
      filename: 'diff.txt',
      stats: [
        { label: 'added', value: String(counts.added) },
        { label: 'removed', value: String(counts.removed) },
        { label: 'changed', value: String(counts.changed) },
      ],
    });
  },
});

const jsonPathTool = defineTool({
  id: 'jsonpath',
  slug: 'jsonpath-tester',
  label: 'JSONPath tester',
  blurb: 'Query a document with JSONPath and see every match with its full path.',
  category: 'Inspect',
  seo: {
    title: 'JSONPath Tester and Evaluator - Online, Nothing Uploaded',
    description:
      'Test JSONPath expressions against your own JSON in the browser. Supports wildcards, recursive descent, slices and filter expressions, and shows the path of every match.',
    heading: 'JSONPath Tester',
    intro:
      'Write a JSONPath expression and see exactly what it selects, with the full path of every match. Useful for building the expression a config file, a CI step or a data pipeline is going to need.',
    keywords: ['jsonpath tester', 'jsonpath evaluator', 'jsonpath online', 'test jsonpath expression', 'jsonpath query'],
    faq: [
      PRIVACY_FAQ,
      {
        question: 'Which JSONPath syntax is supported?',
        answer:
          'Child access ($.a.b and $["a"]), wildcards ($.items[*]), recursive descent ($..email), array indices and negative indices, slices ($.items[1:5]) and single-comparison filters ($.items[?(@.price > 10)]) including the =~ regular expression operator.',
      },
      {
        question: 'Why does my filter return nothing?',
        answer:
          'Filters apply to the children of the current node, so $.items[?(@.active)] filters the elements of items - not items itself. Also check the comparison type: a numeric comparison against a value stored as a string will not match.',
      },
    ],
  },
  inputs: [
    {
      label: 'JSON',
      placeholder:
        '{\n  "items": [\n    { "sku": "A1", "price": 5 },\n    { "sku": "B2", "price": 25 }\n  ]\n}',
      language: 'json' as const,
      accept: ['.json', '.txt'] as const,
    },
  ] as const,
  options: [
    { kind: 'text', key: 'path', label: 'JSONPath', default: '$..*', placeholder: '$.items[?(@.price > 10)]' },
    {
      kind: 'select',
      key: 'output',
      label: 'Output',
      choices: [
        { value: 'values', label: 'Values' },
        { value: 'paths', label: 'Paths' },
        { value: 'both', label: 'Path and value' },
      ],
      default: 'values',
    },
  ],
  run(inputs, options): Result<ToolOutput> {
    const parsed = parseJson(inputs[0] ?? '');
    if (!parsed.ok) return parsed;

    const expression = readString(options, 'path', '$..*') || '$..*';
    const matches = queryJsonPath(parsed.value, expression);
    if (!matches.ok) return matches;

    const mode = readString(options, 'output', 'values');
    let content: string;
    if (mode === 'paths') {
      content = matches.value.map((m) => m.path).join('\n') + '\n';
    } else if (mode === 'both') {
      content =
        matches.value.map((m) => `${m.path}\n  ${JSON.stringify(m.value)}`).join('\n') + '\n';
    } else {
      content = formatJson(
        matches.value.map((m) => m.value),
        { indent: 2, sortKeys: false, minify: false },
      );
    }

    return ok({
      content: matches.value.length === 0 ? 'No matches.\n' : content,
      language: mode === 'values' ? 'json' : 'text',
      filename: 'matches.json',
      stats: [{ label: 'matches', value: String(matches.value.length) }],
    });
  },
});

const redactTool = defineTool({
  id: 'redact',
  slug: 'json-redact-secrets',
  label: 'Secret & PII scanner',
  blurb: 'Find API keys, tokens and personal data in a payload, and mask them before you share it.',
  category: 'Inspect',
  seo: {
    title: 'Redact Secrets and PII from JSON - Runs Entirely Offline',
    description:
      'Scan JSON for API keys, JWTs, private keys, emails and card numbers, then mask them before sharing. Runs in your browser, so the payload you are worried about never leaves the machine.',
    heading: 'JSON Secret & PII Scanner',
    intro:
      'Before you paste an API response into a bug report, a support ticket or a chat window, run it through here. Suspicious key names and suspicious value shapes are both detected, and you can mask, label or drop the matches.',
    keywords: [
      'redact json',
      'remove secrets from json',
      'json pii scanner',
      'mask api keys in json',
      'sanitise json before sharing',
    ],
    faq: [
      {
        question: 'Is it safe to paste a payload that contains real secrets?',
        answer:
          'That is exactly the case this tool is built for. The scan is a pure function running in your browser tab with no network access, so the secrets never leave your machine. You can confirm it by opening your network tab, or by disconnecting from the internet first - the page keeps working.',
      },
      {
        question: 'What does it detect?',
        answer:
          'Two independent signals. Key names that look sensitive (password, api_key, authorization, client_secret and similar), and value shapes that are unmistakable: JWTs, AWS access key ids, GitHub and Slack and Stripe tokens, PEM private key blocks, connection strings with inline passwords, plus emails, phone numbers and card numbers that pass a Luhn check.',
      },
      {
        question: 'Can I rely on it to catch everything?',
        answer:
          'No, and you should not treat any scanner that way. It is a heuristic that catches the common shapes. A bespoke internal token format with no distinguishing pattern, stored under an innocuous key name, will not be flagged. Review the output before you share it.',
      },
    ],
  },
  inputs: [
    {
      label: 'JSON',
      placeholder:
        '{\n  "user": "ada@example.com",\n  "api_key": "9f8c2a1e4b7d0c3f6a5e8b1d",\n  "session": { "token": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc" }\n}',
      language: 'json' as const,
      accept: ['.json', '.txt'] as const,
    },
  ] as const,
  options: [
    {
      kind: 'select',
      key: 'mode',
      label: 'Output',
      choices: [
        { value: 'redacted', label: 'Redacted JSON' },
        { value: 'report', label: 'Findings report' },
      ],
      default: 'redacted',
    },
    {
      kind: 'select',
      key: 'style',
      label: 'Replace with',
      choices: [
        { value: 'mask', label: 'Masked value' },
        { value: 'placeholder', label: '[REDACTED]' },
        { value: 'label', label: 'Type label' },
        { value: 'remove', label: 'Remove the key' },
      ],
      default: 'mask',
    },
    { kind: 'number', key: 'keepChars', label: 'Characters kept', default: 2, min: 0, max: 6, step: 1 },
    { kind: 'boolean', key: 'detectEmails', label: 'Emails', default: true },
    { kind: 'boolean', key: 'detectPhones', label: 'Phone numbers', default: true },
    { kind: 'boolean', key: 'detectCreditCards', label: 'Card numbers', default: true },
    { kind: 'boolean', key: 'detectIpAddresses', label: 'IP addresses', default: false },
    { kind: 'text', key: 'extraKeys', label: 'Extra key names', default: '', placeholder: 'internal_ref, account_no' },
  ],
  run(inputs, options): Result<ToolOutput> {
    const parsed = parseJson(inputs[0] ?? '');
    if (!parsed.ok) return parsed;

    const styleRaw = readString(options, 'style', 'mask');
    const style: RedactStyle =
      styleRaw === 'placeholder' || styleRaw === 'label' || styleRaw === 'remove' ? styleRaw : 'mask';

    const { value, findings } = redactJson(parsed.value, {
      style,
      keepChars: readNumber(options, 'keepChars', 2),
      detectEmails: readBoolean(options, 'detectEmails', true),
      detectPhones: readBoolean(options, 'detectPhones', true),
      detectIpAddresses: readBoolean(options, 'detectIpAddresses', false),
      detectCreditCards: readBoolean(options, 'detectCreditCards', true),
      extraKeys: readString(options, 'extraKeys', ''),
    });

    const high = findings.filter((f) => f.confidence === 'high').length;
    const stats = [
      { label: 'findings', value: String(findings.length) },
      { label: 'high confidence', value: String(high) },
    ];

    if (readString(options, 'mode', 'redacted') === 'report') {
      return ok({
        content: renderFindings(findings),
        language: 'text',
        filename: 'findings.txt',
        stats,
      });
    }

    return ok({
      content: formatJson(value, { indent: 2, sortKeys: false, minify: false }),
      language: 'json',
      filename: 'redacted.json',
      stats,
      warnings:
        findings.length > 0
          ? ['Heuristic scan. Read the output before sharing it - a bespoke token format may not be recognised.']
          : [],
    });
  },
});

export const inspectTools = [diffTool, jsonPathTool, redactTool];
