import { describe, it, expect } from 'vitest';
import { buildToolDefinition, defaultToolDefOptions } from '../src/tool-def.js';
import { lintToolDefinitions } from '../src/lint.js';
import { parseSse, analyseStream } from '../src/sse.js';
import { llmTools } from '../src/tools.js';
import { analyseBudget, renderBudget } from '../src/budget.js';
import { diffToolSchemas, renderSchemaDiff } from '../src/schema-diff.js';
import { defaultOptions } from '@tools/core';

const build = (sample: unknown, over = {}) =>
  buildToolDefinition(sample, { ...defaultToolDefOptions, name: 't', description: 'a'.repeat(40), ...over });

describe('tool definition generation', () => {
  it('produces the three required fields', () => {
    const { definition } = build({ city: 'London' });
    expect(Object.keys(definition)).toEqual(['name', 'description', 'input_schema']);
    expect((definition['input_schema'] as any).type).toBe('object');
    expect((definition['input_schema'] as any).properties.city.type).toBe('string');
  });

  it('strips $schema and title, which belong to a standalone document', () => {
    const schema = build({ a: 1 }).definition['input_schema'] as Record<string, unknown>;
    expect(schema['$schema']).toBeUndefined();
    expect(schema['title']).toBeUndefined();
  });

  it('inlines nested shapes rather than using $defs', () => {
    const schema = build({ filter: { since: '2026-01-01' } }).definition['input_schema'] as any;
    expect(JSON.stringify(schema)).not.toContain('$ref');
    expect(JSON.stringify(schema)).not.toContain('$defs');
    expect(schema.properties.filter.properties.since).toBeDefined();
  });

  it('puts strict beside the other fields, not inside the schema', () => {
    const { definition } = build({ a: 1 }, { strict: true });
    expect(definition['strict']).toBe(true);
    expect((definition['input_schema'] as any).strict).toBeUndefined();
  });

  it('closes the schema when strict is on, because the API requires it', () => {
    const schema = build({ a: 1 }, { strict: true }).definition['input_schema'] as any;
    expect(schema.additionalProperties).toBe(false);
    expect(Array.isArray(schema.required)).toBe(true);
  });

  it('wraps a non-object sample, since arguments are always an object', () => {
    const schema = build([1, 2, 3]).definition['input_schema'] as any;
    expect(schema.type).toBe('object');
    expect(schema.properties.value).toBeDefined();
  });

  it('warns about a missing or thin description', () => {
    expect(build({ a: 1 }, { description: '' }).warnings.join(' ')).toMatch(/most load-bearing/);
    expect(build({ a: 1 }, { description: 'search' }).warnings.join(' ')).toMatch(/very short/i);
  });

  it('rejects an invalid tool name', () => {
    expect(build({ a: 1 }, { name: 'my tool!' }).warnings.join(' ')).toMatch(/not a valid tool name/);
  });

  it('keeps what the samples showed by default', () => {
    // b is absent from the second record, so it is not required.
    const schema = build({ a: 1, b: 2 }).definition['input_schema'] as any;
    expect(schema.required.sort()).toEqual(['a', 'b']);
  });

  it('can relax every property to optional', () => {
    // The useful direction: one sample makes everything look mandatory.
    const schema = build({ a: 1, b: 2 }, { required: 'none' }).definition['input_schema'] as any;
    expect(schema.required).toEqual([]);
  });

  it('can force every property required', () => {
    const schema = build({ a: 1, b: 2 }, { required: 'all' }).definition['input_schema'] as any;
    expect(schema.required.sort()).toEqual(['a', 'b']);
  });
});

describe('linting', () => {
  const lint = (input: unknown) => lintToolDefinitions(input);
  const titles = (input: unknown) => lint(input).map((f) => f.title).join(' | ');
  const valid = {
    name: 'get_weather',
    description: 'Look up the current weather for a named city and return conditions.',
    input_schema: { type: 'object', properties: { city: { type: 'string', description: 'City' } }, required: ['city'] },
  };

  it('passes a well-formed definition', () => {
    expect(lint(valid).filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('flags a missing description as an error, not a nit', () => {
    const findings = lint({ ...valid, description: '' });
    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.title).toMatch(/Missing description/);
  });

  it('flags strict without a closed schema', () => {
    expect(titles({ ...valid, strict: true })).toMatch(/additionalProperties: false/);
  });

  it('accepts strict when the schema is closed', () => {
    const closed = {
      ...valid,
      strict: true,
      input_schema: { ...valid.input_schema, additionalProperties: false },
    };
    expect(lint(closed).filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('flags a required entry naming a property that does not exist', () => {
    expect(titles({ ...valid, input_schema: { ...valid.input_schema, required: ['nope'] } }))
      .toMatch(/"nope" is required but not declared/);
  });

  it('flags a custom tool reusing an Anthropic-defined name', () => {
    const findings = lint({ ...valid, name: 'bash' });
    const hit = findings.find((f) => f.title.includes('Anthropic-defined'));
    expect(hit?.severity).toBe('error');
    expect(hit?.detail).toContain('bash_20250124');
  });

  it('flags a server-defined tool carrying an input_schema', () => {
    expect(titles({ type: 'bash_20250124', name: 'bash', input_schema: { type: 'object' } }))
      .toMatch(/carries an input_schema/);
  });

  it('accepts a server-defined tool with no schema', () => {
    expect(lint({ type: 'bash_20250124', name: 'bash' })).toHaveLength(0);
  });

  it('flags input_schema that is not an object schema', () => {
    expect(titles({ ...valid, input_schema: { type: 'array' } })).toMatch(/must be an object schema/);
  });

  it('flags duplicate tool names in an array', () => {
    expect(titles([valid, valid])).toMatch(/Duplicate tool name/);
  });

  it('flags every tool being deferred', () => {
    expect(titles([{ ...valid, defer_loading: true }])).toMatch(/Every tool is deferred/);
  });

  it('flags the tool-search tool deferring itself', () => {
    const findings = lint([
      { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex', defer_loading: true },
      valid,
    ]);
    expect(findings.map((f) => f.title).join(' | ')).toMatch(/search tool is itself deferred/);
  });

  it('flags mcp_servers declared without an mcp_toolset entry', () => {
    expect(titles({ mcp_servers: [{ type: 'url', url: 'https://x', name: 'x' }], tools: [valid] }))
      .toMatch(/without an mcp_toolset/);
  });

  it('accepts mcp_servers when the toolset is present', () => {
    const findings = lint({
      mcp_servers: [{ type: 'url', url: 'https://x', name: 'x' }],
      tools: [valid, { type: 'mcp_toolset', mcp_server_name: 'x' }],
    });
    expect(findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('notes properties with no description', () => {
    const findings = lint({
      ...valid,
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    });
    expect(findings.find((f) => f.title.includes('no description'))?.severity).toBe('info');
  });

  it('sorts errors above warnings above notes', () => {
    const findings = lint({ name: 'bash', description: '', input_schema: { type: 'object', properties: { a: {} } } });
    expect(findings[0]?.severity).toBe('error');
  });
});

describe('SSE parsing', () => {
  const frame = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const stream = [
    frame('message_start', { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5', usage: { input_tokens: 12 } } }),
    frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
    frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
    frame('message_stop', { type: 'message_stop' }),
  ].join('');

  const unwrap = (text: string) => {
    const r = analyseStream(text);
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };

  it('splits frames and reads the event name', () => {
    const events = parseSse(stream);
    expect(events).toHaveLength(7);
    expect(events[0]?.name).toBe('message_start');
  });

  it('joins text deltas back into the message', () => {
    const a = unwrap(stream);
    expect(a.blocks[0]?.text).toBe('Hello');
    expect(a.blocks[0]?.incomplete).toBe(false);
    expect(a.stopReason).toBe('end_turn');
    expect(a.model).toBe('claude-opus-5');
    expect(a.truncated).toBe(false);
  });

  it('merges usage from message_start and message_delta', () => {
    expect(unwrap(stream).usage).toEqual({ input_tokens: 12, output_tokens: 5 });
  });

  it('reassembles tool call arguments from partial JSON fragments', () => {
    const toolStream = [
      frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'get_weather' } }),
      frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"ci' } }),
      frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ty":"London"}' } }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_stop', { type: 'message_stop' }),
    ].join('');
    const a = unwrap(toolStream);
    expect(a.blocks[0]?.name).toBe('get_weather');
    expect(JSON.parse(a.blocks[0]!.partialJson)).toEqual({ city: 'London' });
  });

  it('detects a truncated stream', () => {
    const cut = stream.split('event: message_stop')[0]!;
    expect(unwrap(cut).truncated).toBe(true);
  });

  it('detects a block that never completed', () => {
    const cut = [
      frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }),
    ].join('');
    expect(unwrap(cut).blocks[0]?.incomplete).toBe(true);
  });

  it('collects thinking deltas as text', () => {
    const t = [
      frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }),
      frame('message_stop', { type: 'message_stop' }),
    ].join('');
    expect(unwrap(t).blocks[0]?.text).toBe('hmm');
  });

  it('surfaces an error frame', () => {
    const e = frame('error', { type: 'error', error: { type: 'overloaded_error' } });
    expect(unwrap(e).streamError).toEqual({ type: 'overloaded_error' });
  });

  it('reads a data-only stream by taking the type from the payload', () => {
    const dataOnly = 'data: {"type":"message_stop"}\n\n';
    const a = unwrap(dataOnly);
    expect(a.events[0]?.name).toBe('message_stop');
    expect(a.truncated).toBe(false);
  });

  it('ignores comments, keep-alives and [DONE]', () => {
    const noisy = ': keep-alive\n\n' + stream + 'data: [DONE]\n\n';
    expect(parseSse(noisy)).toHaveLength(7);
  });

  it('handles CRLF line endings', () => {
    expect(parseSse(stream.replace(/\n/g, '\r\n'))).toHaveLength(7);
  });

  it('records malformed frames rather than failing the whole parse', () => {
    const bad = stream + 'event: content_block_delta\ndata: {not json\n\n';
    const a = unwrap(bad);
    expect(a.malformed).toHaveLength(1);
    expect(a.blocks[0]?.text).toBe('Hello');
  });

  it('rejects a non-streaming JSON body with a usable message', () => {
    const r = analyseStream('{"id":"msg_1","content":[]}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.hint).toMatch(/non-streaming request/);
  });
});

describe('tools', () => {
  const tool = (id: string) => llmTools.find((t) => t.id === id)!;
  const run = (id: string, input: string, over: Record<string, unknown> = {}) =>
    tool(id).run([input], { ...defaultOptions(tool(id)), ...over } as any);

  it('the generator emits parseable JSON', () => {
    const result = run('tool-definition-generator', '{"city":"London"}', { name: 'get_weather' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.value.content).name).toBe('get_weather');
  });

  it('the linter reports a clean definition as acceptable', () => {
    const definition = JSON.stringify({
      name: 'ok_tool',
      description: 'A description long enough to be useful to the model reading it.',
      input_schema: { type: 'object', properties: { a: { type: 'string', description: 'x' } }, required: ['a'] },
    });
    const result = run('tool-definition-linter', definition);
    expect(result.ok && result.value.content).toMatch(/would be accepted by the API/);
  });

  it('the inspector reconstructs a message', () => {
    const s = 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const result = run('sse-inspector', s);
    expect(result.ok && result.value.content).toContain('hi');
  });

  it('every tool reports bad input rather than throwing', () => {
    for (const t of llmTools) {
      expect(t.run(['@@@ not valid @@@'], defaultOptions(t) as any).ok).toBe(false);
    }
  });
});

describe('schema budget', () => {
  const tool = (name: string, props: Record<string, unknown>, description = 'x'.repeat(50)) => ({
    name,
    description,
    input_schema: { type: 'object', properties: props },
  });
  const owner = { type: 'string', description: 'The account or organisation that owns the repository.' };
  const repo = { type: 'string', description: 'The name of the repository.' };

  it('ranks tools by payload share, largest first', () => {
    const a = analyseBudget([
      tool('small', { a: { type: 'string' } }),
      tool('big', { a: owner, b: repo, c: owner, d: repo }),
    ]);
    expect(a.tools[0]?.name).toBe('big');
    expect(a.tools[0]!.bytes).toBeGreaterThan(a.tools[1]!.bytes);
    // The total measures the serialised array, so the brackets and commas
    // between tools are real payload that belongs to no single tool. Shares
    // therefore sum to just under 1 rather than exactly 1.
    const sum = a.tools.reduce((s, t) => s + t.share, 0);
    expect(sum).toBeGreaterThan(0.97);
    expect(sum).toBeLessThanOrEqual(1);
  });

  it('finds fields repeated across tools, which is the largest avoidable cost', () => {
    // The SEP-1576 finding: the same field re-described in tool after tool.
    const a = analyseBudget([
      tool('one', { owner, repo, number: { type: 'integer' } }),
      tool('two', { owner, repo, title: { type: 'string' } }),
      tool('three', { owner, repo }),
    ]);
    const ownerDuplicate = a.duplicates.find((d) => d.field === 'owner');
    expect(ownerDuplicate?.toolCount).toBe(3);
    expect(ownerDuplicate?.identical).toBe(true);
    expect(a.findings.some((f) => /Repeated fields are \d+% of the payload/.test(f.title))).toBe(true);
  });

  it('notices when a repeated field is defined differently in different tools', () => {
    const a = analyseBudget([
      tool('one', { id: { type: 'string' } }),
      tool('two', { id: { type: 'integer' } }),
    ]);
    expect(a.duplicates.find((d) => d.field === 'id')?.identical).toBe(false);
  });

  it('flags tools that share an identical description as high severity', () => {
    const same = 'Does a thing that is described in exactly the same words.';
    const a = analyseBudget([tool('one', { a: owner }, same), tool('two', { b: repo }, same)]);
    const hit = a.findings.find((f) => f.title.includes('identical description'));
    expect(hit?.severity).toBe('high');
  });

  it('flags deep nesting and oversized enums', () => {
    const deep = {
      name: 'deep',
      description: 'd',
      input_schema: {
        type: 'object',
        properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'object', properties: { d: { type: 'string' } } } } } } } },
      },
    };
    expect(analyseBudget([deep]).findings.some((f) => /nests \d+ levels/.test(f.title))).toBe(true);

    const bigEnum = tool('e', { mode: { type: 'string', enum: Array.from({ length: 30 }, (_, i) => `v${i}`) } });
    expect(analyseBudget([bigEnum]).findings.some((f) => /enumerates 30 values/.test(f.title))).toBe(true);
  });

  it('reports bytes rather than pretending to count tokens', () => {
    const out = renderBudget(analyseBudget([tool('a', { x: owner })]), false);
    expect(out).toMatch(/bytes of JSON, not tokens/);
    expect(out).not.toMatch(/\d+ tokens/);
  });

  it('measures multi-byte characters as the bytes they cost', () => {
    const ascii = analyseBudget([tool('a', {}, 'aaaa')]).totalBytes;
    const utf8 = analyseBudget([tool('a', {}, '東京東京')]).totalBytes;
    expect(utf8).toBeGreaterThan(ascii);
  });
});

describe('schema drift', () => {
  const base = {
    name: 'search',
    description: 'Search the knowledge base for matching documents.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search text.' }, limit: { type: 'integer' } },
      required: ['query'],
    },
  };
  const diff = (after: unknown, before: unknown = base) =>
    diffToolSchemas([before], [after]);
  const find = (after: unknown, before: unknown = base) =>
    diff(after, before).changes.map((c) => `${c.kind}:${c.title}`).join(' | ');

  it('calls a removed tool breaking', () => {
    expect(diffToolSchemas([base], []).changes[0]?.kind).toBe('breaking');
  });

  it('calls an added tool additive', () => {
    expect(diffToolSchemas([], [base]).changes[0]?.kind).toBe('additive');
  });

  it('separates a description change as behavioral, not breaking', () => {
    const changed = { ...base, description: 'Search only the archived documents.' };
    const result = diff(changed);
    expect(result.counts.breaking).toBe(0);
    expect(result.counts.behavioral).toBe(1);
    expect(result.changes[0]?.title).toBe('Description changed');
  });

  it('treats an argument description change as behavioral too', () => {
    const changed = {
      ...base,
      input_schema: {
        ...base.input_schema,
        properties: { ...base.input_schema.properties, query: { type: 'string', description: 'A regular expression.' } },
      },
    };
    expect(find(changed)).toMatch(/behavioral:Argument description changed: query/);
  });

  it('calls a new required argument breaking and a new optional one additive', () => {
    const required = {
      ...base,
      input_schema: {
        ...base.input_schema,
        properties: { ...base.input_schema.properties, scope: { type: 'string' } },
        required: ['query', 'scope'],
      },
    };
    expect(find(required)).toMatch(/breaking:Required argument added: scope/);

    const optional = {
      ...base,
      input_schema: {
        ...base.input_schema,
        properties: { ...base.input_schema.properties, scope: { type: 'string' } },
      },
    };
    expect(find(optional)).toMatch(/additive:Optional argument added: scope/);
  });

  it('calls a removed argument and a changed type breaking', () => {
    const removed = {
      ...base,
      input_schema: { ...base.input_schema, properties: { query: base.input_schema.properties.query } },
    };
    expect(find(removed)).toMatch(/breaking:Argument removed: limit/);

    const retyped = {
      ...base,
      input_schema: {
        ...base.input_schema,
        properties: { ...base.input_schema.properties, limit: { type: 'string' } },
      },
    };
    expect(find(retyped)).toMatch(/breaking:Type changed: limit/);
  });

  it('distinguishes narrowing an enum from widening it', () => {
    const withEnum = {
      ...base,
      input_schema: {
        ...base.input_schema,
        properties: { ...base.input_schema.properties, limit: { type: 'integer', enum: [1, 2, 3] } },
      },
    };
    const narrowed = {
      ...withEnum,
      input_schema: {
        ...withEnum.input_schema,
        properties: { ...withEnum.input_schema.properties, limit: { type: 'integer', enum: [1, 2] } },
      },
    };
    expect(find(narrowed, withEnum)).toMatch(/breaking:Allowed values removed from limit/);
    expect(find(withEnum, narrowed)).toMatch(/additive:Allowed values added to limit/);
  });

  it('calls newly introducing an enum breaking', () => {
    const restricted = {
      ...base,
      input_schema: {
        ...base.input_schema,
        properties: { ...base.input_schema.properties, limit: { type: 'integer', enum: [1, 2] } },
      },
    };
    expect(find(restricted)).toMatch(/breaking:limit restricted to a fixed set/);
  });

  it('tracks required becoming optional and back', () => {
    const relaxed = { ...base, input_schema: { ...base.input_schema, required: [] } };
    expect(find(relaxed)).toMatch(/additive:query is no longer required/);
    expect(find(base, relaxed)).toMatch(/breaking:query is now required/);
  });

  it('calls enabling strict mode breaking', () => {
    expect(find({ ...base, strict: true })).toMatch(/breaking:strict mode enabled/);
  });

  it('reports identical sets as identical', () => {
    const result = diffToolSchemas([base], [base]);
    expect(result.changes).toHaveLength(0);
    expect(renderSchemaDiff(result, false)).toMatch(/identical/);
  });

  it('sorts breaking changes above behavioral above additive', () => {
    const messy = {
      ...base,
      description: 'Different words entirely.',
      input_schema: {
        ...base.input_schema,
        properties: { query: base.input_schema.properties.query, extra: { type: 'string' } },
      },
    };
    const kinds = diff(messy).changes.map((c) => c.kind);
    expect(kinds[0]).toBe('breaking');
    expect(kinds).toEqual([...kinds].sort((a, b) =>
      ({ breaking: 0, behavioral: 1, additive: 2 })[a] - ({ breaking: 0, behavioral: 1, additive: 2 })[b]));
  });

  it('explains why behavioral changes matter in the output', () => {
    const changed = { ...base, description: 'Something else.' };
    expect(renderSchemaDiff(diff(changed), false)).toMatch(/do not announce themselves/);
  });
});
