import { ok, err } from '@tools/core';
import type { Result } from '@tools/core';

/**
 * Reconstructs a Messages API response from a raw SSE stream.
 *
 * A captured stream is thousands of one-line JSON frames — unreadable by eye,
 * too long to hand to a model, and full of whatever the request carried. It is
 * also where streaming bugs live: a truncated stream, a tool call whose
 * arguments never finished arriving, an error frame halfway through.
 */

export interface SseEvent {
  /** The `event:` field, or the payload's own `type` when it is data-only. */
  name: string;
  data: unknown;
  /** 1-indexed position in the stream. */
  index: number;
  raw: string;
}

export interface ContentBlock {
  index: number;
  type: string;
  text: string;
  /** For tool_use blocks: the accumulated partial JSON of the arguments. */
  partialJson: string;
  name?: string;
  id?: string;
  /** Set when the block never received its content_block_stop. */
  incomplete: boolean;
}

export interface StreamAnalysis {
  events: SseEvent[];
  blocks: ContentBlock[];
  model?: string;
  stopReason?: string;
  usage?: Record<string, unknown>;
  messageId?: string;
  /** Frames whose payload did not parse as JSON. */
  malformed: number[];
  /** An `error` event carried by the stream. */
  streamError?: unknown;
  /** True when no message_stop arrived. */
  truncated: boolean;
  eventCounts: Record<string, number>;
}

/** Splits a raw SSE body into frames, tolerating CRLF and data-only streams. */
export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  const normalised = text.replace(/\r\n/g, '\n');

  for (const chunk of normalised.split(/\n\n+/)) {
    const trimmed = chunk.trim();
    if (trimmed.length === 0) continue;

    let name = '';
    const dataLines: string[] = [];
    for (const line of trimmed.split('\n')) {
      if (line.startsWith(':')) continue; // comment / keep-alive
      const separator = line.indexOf(':');
      const field = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
      if (field === 'event') name = value;
      else if (field === 'data') dataLines.push(value);
    }

    if (dataLines.length === 0) continue;
    const payload = dataLines.join('\n');
    if (payload === '[DONE]') continue;

    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      data = undefined;
    }
    // A data-only stream still names its type inside the payload.
    if (name === '' && data !== null && typeof data === 'object') {
      const type = (data as Record<string, unknown>)['type'];
      if (typeof type === 'string') name = type;
    }
    events.push({ name: name || 'unknown', data, index: events.length + 1, raw: payload });
  }

  return events;
}

const asObject = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export function analyseStream(text: string): Result<StreamAnalysis> {
  if (text.trim().length === 0) {
    return err({ message: 'Nothing to read yet.', hint: 'Paste a captured SSE response body.' });
  }

  const events = parseSse(text);
  if (events.length === 0) {
    return err({
      message: 'No SSE frames found.',
      hint: 'Frames look like "event: content_block_delta" followed by a "data:" line, separated by blank lines. A JSON body from a non-streaming request will not parse here.',
    });
  }

  const blocks = new Map<number, ContentBlock>();
  const eventCounts: Record<string, number> = {};
  const malformed: number[] = [];
  const analysis: StreamAnalysis = {
    events,
    blocks: [],
    malformed,
    truncated: true,
    eventCounts,
  };

  for (const event of events) {
    eventCounts[event.name] = (eventCounts[event.name] ?? 0) + 1;
    if (event.data === undefined) {
      malformed.push(event.index);
      continue;
    }
    const data = asObject(event.data);
    if (!data) continue;

    switch (event.name) {
      case 'message_start': {
        const message = asObject(data['message']);
        if (message) {
          if (typeof message['id'] === 'string') analysis.messageId = message['id'];
          if (typeof message['model'] === 'string') analysis.model = message['model'];
          const usage = asObject(message['usage']);
          if (usage) analysis.usage = { ...usage };
        }
        break;
      }
      case 'content_block_start': {
        const index = typeof data['index'] === 'number' ? data['index'] : blocks.size;
        const block = asObject(data['content_block']);
        blocks.set(index, {
          index,
          type: typeof block?.['type'] === 'string' ? (block['type'] as string) : 'unknown',
          text: typeof block?.['text'] === 'string' ? (block['text'] as string) : '',
          partialJson: '',
          ...(typeof block?.['name'] === 'string' ? { name: block['name'] as string } : {}),
          ...(typeof block?.['id'] === 'string' ? { id: block['id'] as string } : {}),
          incomplete: true,
        });
        break;
      }
      case 'content_block_delta': {
        const index = typeof data['index'] === 'number' ? data['index'] : 0;
        const block = blocks.get(index);
        if (!block) break;
        const delta = asObject(data['delta']);
        if (!delta) break;
        // Each delta type appends to a different field of the same block.
        if (typeof delta['text'] === 'string') block.text += delta['text'];
        else if (typeof delta['thinking'] === 'string') block.text += delta['thinking'];
        else if (typeof delta['partial_json'] === 'string') block.partialJson += delta['partial_json'];
        break;
      }
      case 'content_block_stop': {
        const index = typeof data['index'] === 'number' ? data['index'] : 0;
        const block = blocks.get(index);
        if (block) block.incomplete = false;
        break;
      }
      case 'message_delta': {
        const delta = asObject(data['delta']);
        if (delta && typeof delta['stop_reason'] === 'string') {
          analysis.stopReason = delta['stop_reason'];
        }
        const usage = asObject(data['usage']);
        if (usage) analysis.usage = { ...(analysis.usage ?? {}), ...usage };
        break;
      }
      case 'message_stop':
        analysis.truncated = false;
        break;
      case 'error':
        analysis.streamError = data['error'] ?? data;
        break;
      default:
        break;
    }
  }

  analysis.blocks = [...blocks.values()].sort((a, b) => a.index - b.index);
  return ok(analysis);
}

export function renderAnalysis(analysis: StreamAnalysis, showTimeline: boolean): string {
  const lines: string[] = [];

  lines.push(
    `${analysis.events.length} events` +
      (analysis.model ? `  ·  ${analysis.model}` : '') +
      (analysis.stopReason ? `  ·  stop_reason: ${analysis.stopReason}` : ''),
  );
  lines.push('');

  if (analysis.streamError !== undefined) {
    lines.push('STREAM ERROR', `  ${JSON.stringify(analysis.streamError)}`, '');
  }
  if (analysis.truncated) {
    lines.push(
      'TRUNCATED',
      '  No message_stop event. The capture is incomplete, or the connection dropped',
      '  before the response finished.',
      '',
    );
  }
  if (analysis.malformed.length > 0) {
    lines.push(
      `MALFORMED FRAMES (${analysis.malformed.length})`,
      `  Frames ${analysis.malformed.slice(0, 10).join(', ')}${analysis.malformed.length > 10 ? ', …' : ''} did not parse as JSON.`,
      '  Usually a capture that split a frame across buffer boundaries.',
      '',
    );
  }

  for (const block of analysis.blocks) {
    const label = block.name ? `${block.type} (${block.name})` : block.type;
    lines.push(`[${block.index}] ${label}${block.incomplete ? '   ← never completed' : ''}`);

    if (block.partialJson.length > 0) {
      let rendered = block.partialJson;
      let note = '';
      try {
        rendered = JSON.stringify(JSON.parse(block.partialJson), null, 2);
      } catch {
        // Arguments arrive as a stream of fragments; incomplete JSON here means
        // the tool call was cut off, which is the bug worth surfacing.
        note = '   ← arguments are not valid JSON; the call was cut off mid-stream';
      }
      lines.push(`  arguments${note}`);
      for (const line of rendered.split('\n')) lines.push(`    ${line}`);
    }
    if (block.text.length > 0) {
      for (const line of block.text.split('\n')) lines.push(`    ${line}`);
    }
    lines.push('');
  }

  if (analysis.usage) {
    lines.push('USAGE');
    for (const [key, value] of Object.entries(analysis.usage)) {
      lines.push(`  ${key.padEnd(28)} ${JSON.stringify(value)}`);
    }
    lines.push('');
  }

  lines.push('EVENT COUNTS');
  for (const [name, count] of Object.entries(analysis.eventCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${name.padEnd(24)} ${count}`);
  }

  if (showTimeline) {
    lines.push('', 'TIMELINE');
    for (const event of analysis.events) {
      const summary = event.raw.length > 96 ? event.raw.slice(0, 93) + '…' : event.raw;
      lines.push(`  ${String(event.index).padStart(4)}  ${event.name.padEnd(22)} ${summary}`);
    }
  }

  return lines.join('\n') + '\n';
}
