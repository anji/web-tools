import { inferSchema, emitJsonSchema, defaultJsonSchemaOptions } from '@tools/codegen';

/**
 * Builds an Anthropic Messages API tool definition from a sample of the
 * arguments a tool takes.
 *
 * The shape is `{ name, description, input_schema }`, with `strict` as an
 * optional sibling of those three -- not nested inside the schema, and not on
 * `tool_choice`, which is where it is most often mistakenly put.
 */

export interface ToolDefOptions {
  name: string;
  description: string;
  /**
   * Emit `strict: true`, which guarantees the arguments validate exactly.
   * It requires `additionalProperties: false` and a `required` array, so both
   * are added when it is on.
   */
  strict: boolean;
  /**
   * How to fill `required`.
   *
   * A single sample makes every key look mandatory, which is rarely true — so
   * the useful control is relaxing that, not tightening it. 'inferred' keeps
   * what the samples showed, 'all' forces every property, 'none' makes them
   * all optional for you to tighten by hand.
   */
  required: 'inferred' | 'all' | 'none';
}

export const defaultToolDefOptions: ToolDefOptions = {
  name: 'my_tool',
  description: '',
  strict: false,
  required: 'inferred',
};

type JsonObject = Record<string, unknown>;

/**
 * Providers differ on whether they follow $ref, so nested shapes are inlined
 * rather than hoisted into $defs.
 */
function buildInputSchema(sample: unknown, options: ToolDefOptions): JsonObject {
  const emitted = emitJsonSchema(inferSchema(sample), {
    ...defaultJsonSchemaOptions,
    useDefs: false,
    markRequired: true,
    closed: options.strict,
    rootName: 'input',
  });

  const document = JSON.parse(emitted.code) as JsonObject;
  // $schema and title belong to a standalone schema document, not to an
  // input_schema embedded in a tool definition.
  delete document['$schema'];
  delete document['title'];

  if (document['type'] !== 'object') {
    // A tool's arguments are always an object; wrap anything else so the
    // definition stays valid rather than silently wrong.
    return {
      type: 'object',
      properties: { value: document },
      required: ['value'],
      ...(options.strict ? { additionalProperties: false } : {}),
    };
  }

  if (document['properties']) {
    if (options.required === 'all') {
      document['required'] = Object.keys(document['properties'] as JsonObject);
    } else if (options.required === 'none') {
      document['required'] = [];
    }
  }
  if (options.strict) {
    document['additionalProperties'] = false;
    if (!document['required']) document['required'] = [];
  }
  return document;
}

export interface ToolDefResult {
  definition: JsonObject;
  warnings: string[];
}

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export function buildToolDefinition(sample: unknown, options: ToolDefOptions): ToolDefResult {
  const warnings: string[] = [];
  const name = options.name.trim() || 'my_tool';

  if (!NAME_PATTERN.test(name)) {
    warnings.push(
      `"${name}" is not a valid tool name. Use letters, digits, underscores and hyphens, up to 128 characters.`,
    );
  }
  if (options.description.trim().length === 0) {
    warnings.push(
      'No description. This is the single most load-bearing field in a tool definition — the model chooses when to call the tool almost entirely from it. Describe what the tool does, when to use it, and what it returns.',
    );
  } else if (options.description.trim().length < 30) {
    warnings.push(
      'The description is very short. A few sentences covering when to use the tool, and when not to, measurably improves how reliably it gets called.',
    );
  }

  const definition: JsonObject = {
    name,
    description: options.description.trim(),
    input_schema: buildInputSchema(sample, options),
  };
  if (options.strict) definition['strict'] = true;

  return { definition, warnings };
}
