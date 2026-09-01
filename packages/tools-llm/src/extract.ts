/**
 * Normalises what people actually paste: a single tool definition, a tools
 * array, or a whole request body. Every tool in this section accepts all
 * three, because a captured request is usually what is closest to hand.
 */

export const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

export interface Extracted {
  tools: unknown[];
  /** Present when the input was a whole request body. */
  body?: Record<string, unknown>;
}

export function extractTools(input: unknown): Extracted | undefined {
  if (Array.isArray(input)) return { tools: input };
  if (isObject(input)) {
    if (Array.isArray(input['tools'])) return { tools: input['tools'], body: input };
    return { tools: [input] };
  }
  return undefined;
}

/** Bytes on the wire, which is what the payload actually costs. */
export const byteLength = (value: unknown): number =>
  new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value) ?? '').length;

export const toolName = (tool: unknown, index: number): string =>
  isObject(tool) && typeof tool['name'] === 'string' ? tool['name'] : `tools[${index}]`;
