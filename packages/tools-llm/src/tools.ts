import { defineTool, ok, readBoolean, readString, type Result, type ToolOutput } from '@tools/core';
import { parseJson } from './parse.js';
import { buildToolDefinition, defaultToolDefOptions } from './tool-def.js';
import { lintToolDefinitions } from './lint.js';
import { analyseStream, renderAnalysis } from './sse.js';
import { analyseBudget, renderBudget } from './budget.js';
import { diffToolSchemas, renderSchemaDiff } from './schema-diff.js';
import { extractTools } from './extract.js';

const PRIVACY_FAQ = {
  question: 'Is what I paste sent anywhere?',
  answer:
    'No — and it is worth being concrete about why that matters here. A prompt, a captured response and a tool definition all contain the things people are most careful with: system instructions, customer data, internal endpoints. Every tool on this page is a pure function running in your tab, on a page whose Content-Security-Policy sets connect-src to ‘none’, so the browser will not let it open a network connection at all.',
};

const SCOPE_FAQ = {
  question: 'Which API do these target?',
  answer:
    'The Anthropic Messages API. Other providers use different shapes for the same concepts, and emitting a format from memory is exactly how a tool ends up confidently wrong — so rather than guess, this section covers the one it can be precise about.',
};

const generatorTool = defineTool({
  id: 'tool-definition-generator',
  slug: 'tool-definition-generator',
  label: 'Tool definition generator',
  blurb: 'Turn a sample of a tool’s arguments into a valid tool definition.',
  category: 'Code generation',
  seo: {
    title: 'Generate an Anthropic Tool Definition from Sample Arguments',
    description:
      'Paste a sample of the arguments your tool takes and get a valid Anthropic Messages API tool definition, with the input_schema inferred and strict mode wired correctly. Nothing uploaded.',
    heading: 'Tool Definition Generator',
    intro:
      'Writing an input_schema by hand is tedious and easy to get subtly wrong. Paste an example of the arguments your tool takes and get the definition, with nested shapes inlined rather than hoisted into $defs.',
    keywords: [
      'anthropic tool definition',
      'generate tool schema',
      'claude tool use schema',
      'input_schema generator',
      'json to tool definition',
    ],
    faq: [
      PRIVACY_FAQ,
      SCOPE_FAQ,
      {
        question: 'What does strict mode change?',
        answer:
          'It guarantees the arguments the model sends validate exactly against your schema. The API only accepts it on a closed schema, so turning it on also sets additionalProperties to false and ensures a required array exists. Note that strict is a sibling of name, description and input_schema — not something you put on tool_choice, which is the most common way it gets misplaced.',
      },
      {
        question: 'Why are nested objects inlined instead of using $defs?',
        answer:
          'Because support for $ref varies. An inlined schema is longer but unambiguous, and a tool definition is written once and read by a model many times — clarity beats brevity.',
      },
      {
        question: 'Why does it keep telling me to write a longer description?',
        answer:
          'Because the description is the highest-leverage text in the entire definition. The model decides whether to call a tool almost entirely from it — not from the name, and not from the schema. A schema that is perfect and a description that is one word gives you a tool that is never called, or called at the wrong moment.',
      },
    ],
  },
  inputs: [
    {
      label: 'Sample arguments',
      placeholder: '{\n  "query": "quarterly revenue",\n  "limit": 10,\n  "include_archived": false\n}',
      language: 'json' as const,
      accept: ['.json', '.txt'] as const,
    },
  ] as const,
  options: [
    { kind: 'text', key: 'name', label: 'Tool name', default: 'my_tool', placeholder: 'search_documents' },
    { kind: 'text', key: 'description', label: 'Description', default: '', placeholder: 'What it does and when to use it' },
    { kind: 'boolean', key: 'strict', label: 'Strict mode', default: false, help: 'Closes the schema and guarantees exact validation.' },
    {
      kind: 'select',
      key: 'required',
      label: 'Required fields',
      choices: [
        { value: 'inferred', label: 'As in the sample' },
        { value: 'all', label: 'All properties' },
        { value: 'none', label: 'None' },
      ],
      default: 'inferred',
    },
  ],
  run(inputs, options): Result<ToolOutput> {
    const parsed = parseJson(inputs[0] ?? '');
    if (!parsed.ok) return parsed;

    const result = buildToolDefinition(parsed.value, {
      ...defaultToolDefOptions,
      name: readString(options, 'name', 'my_tool'),
      description: readString(options, 'description', ''),
      strict: readBoolean(options, 'strict', false),
      required: ((v) => (v === 'all' || v === 'none' ? v : 'inferred'))(
        readString(options, 'required', 'inferred'),
      ),
    });

    const properties = (result.definition['input_schema'] as Record<string, unknown>)['properties'];
    const count = properties && typeof properties === 'object' ? Object.keys(properties).length : 0;

    return ok({
      content: JSON.stringify(result.definition, null, 2) + '\n',
      language: 'json',
      filename: 'tool-definition.json',
      stats: [
        { label: 'properties', value: String(count) },
        { label: 'strict', value: readBoolean(options, 'strict', false) ? 'yes' : 'no' },
      ],
      warnings: result.warnings,
    });
  },
});

const linterTool = defineTool({
  id: 'tool-definition-linter',
  slug: 'tool-definition-linter',
  label: 'Tool definition linter',
  blurb: 'Check a tool definition against the constraints the API actually enforces.',
  category: 'Inspect',
  seo: {
    title: 'Tool Definition Linter - Catch the 400 Before You Send It',
    description:
      'Validate an Anthropic tool definition, an array of them, or a whole request body. Checks strict-mode requirements, name collisions with server-defined tools, deferred-loading rules and MCP toolset pairing.',
    heading: 'Tool Definition Linter',
    intro:
      'Paste a tool definition, a tools array, or an entire request body. Every rule checked here corresponds to something the API enforces or something that quietly changes how the model behaves — this is a validator, not a style guide.',
    keywords: [
      'tool definition validator',
      'anthropic tools 400 error',
      'validate input_schema',
      'strict tool use requirements',
      'tool schema linter',
    ],
    faq: [
      PRIVACY_FAQ,
      SCOPE_FAQ,
      {
        question: 'What does it actually check?',
        answer:
          'Strict mode requiring a closed schema and a required array; required entries naming properties that exist; custom tools reusing the name of an Anthropic-defined tool such as bash or memory, which produces a different tool than the author expects; server-defined tools carrying an input_schema they should not have; duplicate names; every tool being deferred, or the tool-search tool deferring itself, both of which return a 400; and mcp_servers declared without the matching mcp_toolset entry.',
      },
      {
        question: 'Why is naming a tool "bash" an error?',
        answer:
          'Because the built-in bash tool is identified by its type, not its name, and takes no schema of yours. A custom tool that merely borrows the name is a completely separate tool — the model does not get the built-in behaviour, and nothing in the response says so.',
      },
    ],
  },
  inputs: [
    {
      label: 'Tool definition, array, or request body',
      placeholder:
        '{\n  "name": "get_weather",\n  "description": "Look up the current weather for a city.",\n  "input_schema": {\n    "type": "object",\n    "properties": { "city": { "type": "string" } },\n    "required": ["city"]\n  }\n}',
      language: 'json' as const,
      accept: ['.json', '.txt'] as const,
    },
  ] as const,
  options: [
    {
      kind: 'select',
      key: 'minSeverity',
      label: 'Show',
      choices: [
        { value: 'info', label: 'Everything' },
        { value: 'warning', label: 'Warnings and errors' },
        { value: 'error', label: 'Errors only' },
      ],
      default: 'info',
    },
  ],
  run(inputs, options): Result<ToolOutput> {
    const parsed = parseJson(inputs[0] ?? '');
    if (!parsed.ok) return parsed;

    const findings = lintToolDefinitions(parsed.value);
    const rank: Record<string, number> = { error: 0, warning: 1, info: 2 };
    const floor = rank[readString(options, 'minSeverity', 'info')] ?? 2;
    const shown = findings.filter((f) => (rank[f.severity] ?? 2) <= floor);

    const counts = { error: 0, warning: 0, info: 0 };
    for (const f of findings) counts[f.severity]++;

    const lines: string[] =
      shown.length === 0
        ? ['Nothing flagged at this level.', '']
        : shown.flatMap((f) => [
            `[${f.severity.toUpperCase()}]${f.tool ? ` ${f.tool}:` : ''} ${f.title}`,
            `  ${f.detail}`,
            '',
          ]);

    if (counts.error === 0) {
      lines.push('No errors. This would be accepted by the API as written.');
    }

    return ok({
      content: lines.join('\n') + '\n',
      language: 'text',
      filename: 'lint.txt',
      stats: [
        { label: 'errors', value: String(counts.error) },
        { label: 'warnings', value: String(counts.warning) },
      ],
    });
  },
});

const streamTool = defineTool({
  id: 'sse-inspector',
  slug: 'streaming-response-inspector',
  label: 'Streaming response inspector',
  blurb: 'Reconstruct a message from a raw SSE stream and find where it broke.',
  category: 'Inspect',
  seo: {
    title: 'SSE Stream Inspector - Reconstruct a Streamed LLM Response',
    description:
      'Paste a captured server-sent events body and get the reconstructed message: text, tool calls with their assembled arguments, usage, stop reason, and whether the stream was truncated. Nothing uploaded.',
    heading: 'Streaming Response Inspector',
    intro:
      'A captured stream is thousands of one-line JSON frames. This reassembles them into the message they describe — the text, the tool calls with their arguments joined back together, the usage totals — and points at where it went wrong when it did.',
    keywords: [
      'sse stream debugger',
      'parse server sent events',
      'streaming response inspector',
      'debug llm streaming',
      'content_block_delta',
    ],
    faq: [
      PRIVACY_FAQ,
      {
        question: 'Why not just read the stream?',
        answer:
          'Because a normal response is thousands of frames, each a fragment of one token, and the interesting parts are spread across all of them. Tool call arguments in particular arrive as a stream of partial JSON in input_json_delta frames — a single argument object can be split across a hundred events, and you cannot tell whether it was complete without joining them.',
      },
      {
        question: 'What does "arguments are not valid JSON" mean?',
        answer:
          'That a tool call was cut off mid-stream. Arguments arrive as fragments that only form valid JSON once the last one lands, so a partial result means the response ended before the call finished — usually hitting max_tokens, or a dropped connection. It is the most common streaming bug and it is invisible unless you reassemble the fragments.',
      },
      {
        question: 'It says TRUNCATED but my code worked.',
        answer:
          'Then the capture is incomplete rather than the response. A stream is complete when a message_stop event arrives; copying from a terminal or a devtools pane often loses the tail. It also flags genuinely dropped connections, which is the case worth knowing about.',
      },
    ],
  },
  inputs: [
    {
      label: 'Raw SSE body',
      placeholder:
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01","model":"claude-opus-5","usage":{"input_tokens":12}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      language: 'text' as const,
      accept: ['.txt', '.log', '.sse'] as const,
    },
  ] as const,
  options: [
    { kind: 'boolean', key: 'timeline', label: 'Show event timeline', default: false },
  ],
  run(inputs, options): Result<ToolOutput> {
    const analysis = analyseStream(inputs[0] ?? '');
    if (!analysis.ok) return analysis;

    const value = analysis.value;
    const warnings: string[] = [];
    if (value.truncated) warnings.push('No message_stop event — the stream is incomplete.');
    if (value.blocks.some((b) => b.incomplete)) {
      warnings.push('At least one content block never received its content_block_stop.');
    }

    const stats = [
      { label: 'events', value: String(value.events.length) },
      { label: 'blocks', value: String(value.blocks.length) },
    ];
    if (value.stopReason) stats.push({ label: 'stop', value: value.stopReason });

    return ok({
      content: renderAnalysis(value, readBoolean(options, 'timeline', false)),
      language: 'text',
      filename: 'stream.txt',
      stats,
      warnings,
    });
  },
});

const TOOLS_INPUT = (label: string) => ({
  label,
  placeholder: '[\n  {\n    "name": "search",\n    "description": "…",\n    "input_schema": { "type": "object", "properties": { "query": { "type": "string" } } }\n  }\n]',
  language: 'json' as const,
  accept: ['.json', '.txt'] as const,
});

const budgetTool = defineTool({
  id: 'tool-schema-budget',
  slug: 'tool-schema-budget',
  label: 'Tool schema budget',
  blurb: 'Find which tool definitions are eating your context, and the fields duplicated across them.',
  category: 'Inspect',
  seo: {
    title: 'Tool Schema Budget - Which Tools Are Eating Your Context Window',
    description:
      'Measure what a set of tool definitions costs to send. Ranks tools by payload share, finds fields repeated across many tools, and flags oversized enums and deep nesting. Runs in your browser.',
    heading: 'Tool Schema Budget',
    intro:
      'Tool definitions are sent on every single request, before the user has said anything. Paste a tools array to see which ones dominate the payload and which fields are being re-described in tool after tool.',
    keywords: [
      'mcp token bloat',
      'tool schema size',
      'reduce tool definition tokens',
      'mcp context window',
      'tool schema overhead',
    ],
    faq: [
      PRIVACY_FAQ,
      {
        question: 'Why bytes and not tokens?',
        answer:
          'Because a token count computed here would be wrong. Token counts are model-specific and only exact from a count_tokens endpoint, and general-purpose tokenizers are off by enough to mislead — particularly on JSON, which is mostly punctuation and short identifiers. What you act on is the ranking and the share, and bytes give both exactly. Treat the numbers as relative, and get an absolute count from the API when you need one.',
      },
      {
        question: 'Why do repeated fields matter so much?',
        answer:
          'Because the definition is re-sent once per tool, on every request. An analysis of GitHub’s own MCP server found "owner" in 36 of 60 tool schemas and "repo" in 39 — the same few lines of JSON, paid for dozens of times. Shared fields are usually the largest avoidable cost in a tool set, and the easiest to spot once something counts them.',
      },
      {
        question: 'Is a long description a problem?',
        answer:
          'Usually not. The description is what makes a tool get called correctly, and trimming it to save bytes is a bad trade. It is flagged only so you can check the length is doing work rather than restating the schema in prose.',
      },
      {
        question: 'How much does this actually cost?',
        answer:
          'A report on the MCP spec repository measured about 1,000 tokens for a heavy tool and roughly 10,000 tokens for a 20-tool set before any user message, putting first-turn schema cost at around $390 across 2,600 conversations. The author’s point was that the context spent is capacity the model no longer has for reasoning — the bill is the smaller half of the problem.',
      },
    ],
  },
  inputs: [TOOLS_INPUT('Tools array or request body')] as const,
  options: [
    { kind: 'boolean', key: 'showAll', label: 'Show every tool', default: false, help: 'Otherwise the 15 largest.' },
  ],
  run(inputs, options): Result<ToolOutput> {
    const parsed = parseJson(inputs[0] ?? '');
    if (!parsed.ok) return parsed;

    const extracted = extractTools(parsed.value);
    if (!extracted || extracted.tools.length === 0) {
      return {
        ok: false,
        error: {
          message: 'No tools found.',
          hint: 'Paste a tools array, a single tool definition, or a request body containing one.',
        },
      };
    }

    const analysis = analyseBudget(extracted.tools);
    const duplicateBytes = analysis.duplicates.reduce((sum, d) => sum + d.bytes, 0);

    return ok({
      content: renderBudget(analysis, readBoolean(options, 'showAll', false)),
      language: 'text',
      filename: 'schema-budget.txt',
      stats: [
        { label: 'tools', value: String(analysis.tools.length) },
        { label: 'payload', value: `${(analysis.totalBytes / 1024).toFixed(1)} KB` },
        {
          label: 'repeated',
          value: analysis.totalBytes > 0 ? `${Math.round((duplicateBytes / analysis.totalBytes) * 100)}%` : '0%',
        },
      ],
    });
  },
});

const schemaDiffTool = defineTool({
  id: 'tool-schema-diff',
  slug: 'tool-schema-diff',
  label: 'Tool schema diff',
  blurb: 'Compare two versions of a tool set and separate breaking from merely behavioral.',
  category: 'Inspect',
  seo: {
    title: 'Tool Schema Diff - Catch Silent Drift Between Tool Set Versions',
    description:
      'Compare two versions of a tool definition set. Separates breaking changes from additive ones, and calls out description changes that alter how a model behaves without breaking anything.',
    heading: 'Tool Schema Diff',
    intro:
      'Tool schemas change under you. Some of those changes break calls outright; the more awkward ones change nothing structural and simply make the model choose differently. Paste both versions to see which is which.',
    keywords: [
      'mcp schema drift',
      'tool schema breaking change',
      'compare mcp tool versions',
      'tool definition diff',
      'mcp contract testing',
    ],
    faq: [
      PRIVACY_FAQ,
      {
        question: 'Why is a description change worth flagging?',
        answer:
          'Because it is the one that gets missed. The signature is unchanged, every existing call still validates, nothing errors — and the model now decides differently about when to reach for the tool and what to put in its arguments. A line diff shows it as one changed string among many; here it gets its own category.',
      },
      {
        question: 'What counts as breaking?',
        answer:
          'A tool removed, an argument removed, a required argument added, a type changed, an optional argument becoming required, allowed values removed from an enum, or strict mode being switched on. Each of these rejects a call that previously worked.',
      },
      {
        question: 'Why does this need a tool at all?',
        answer:
          'Because tool sets have no versioning discipline yet. There is no contract testing and no breaking-change detection in the ecosystem, so a server can change what it exposes between deploys with nothing to compare against. A drifted tool does not throw — it returns a confident wrong answer, which is considerably harder to notice.',
      },
    ],
  },
  inputs: [TOOLS_INPUT('Before'), TOOLS_INPUT('After')] as const,
  options: [
    { kind: 'boolean', key: 'hideAdditive', label: 'Hide additive changes', default: false },
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

    const beforeTools = extractTools(before.value);
    const afterTools = extractTools(after.value);
    if (!beforeTools || !afterTools) {
      return {
        ok: false,
        error: {
          message: 'Could not read one side as tool definitions.',
          hint: 'Each side should be a tools array, a single tool definition, or a request body containing one.',
        },
      };
    }

    const diff = diffToolSchemas(beforeTools.tools, afterTools.tools);

    return ok({
      content: renderSchemaDiff(diff, readBoolean(options, 'hideAdditive', false)),
      language: 'text',
      filename: 'schema-diff.txt',
      stats: [
        { label: 'breaking', value: String(diff.counts.breaking) },
        { label: 'behavioral', value: String(diff.counts.behavioral) },
        { label: 'additive', value: String(diff.counts.additive) },
      ],
      warnings:
        diff.counts.breaking > 0
          ? ['Breaking changes present — existing calls will start failing against the new version.']
          : [],
    });
  },
});

export const llmTools = [generatorTool, linterTool, streamTool, budgetTool, schemaDiffTool];
