/**
 * Lints an Anthropic Messages API tool definition against the constraints the
 * API actually enforces.
 *
 * Every rule here corresponds to a documented requirement or a request that
 * returns a 400 — this is a validator, not a style guide.
 */

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  title: string;
  detail: string;
  /** Which tool in the array, when linting a list. */
  tool?: string;
}

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Anthropic-defined tools are identified by `type` and carry no schema of your
 * own. A custom tool that merely borrows the name is a different tool.
 */
const ANTHROPIC_DEFINED = new Map<string, string>([
  ['bash', 'bash_20250124'],
  ['str_replace_based_edit_tool', 'text_editor_20250728'],
  ['memory', 'memory_20250818'],
  ['code_execution', 'code_execution_20260521'],
  ['web_search', 'web_search_20260209'],
  ['web_fetch', 'web_fetch_20260209'],
]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function lintOne(tool: Record<string, unknown>, index: number, findings: Finding[]): void {
  const name = typeof tool['name'] === 'string' ? tool['name'] : `tool[${index}]`;
  const at = (severity: Severity, title: string, detail: string): void => {
    findings.push({ severity, title, detail, tool: name });
  };

  const type = tool['type'];
  const isServerTool = typeof type === 'string' && type.length > 0;

  // --- Anthropic-defined tools -------------------------------------------
  if (isServerTool) {
    if (tool['input_schema'] !== undefined) {
      at(
        'error',
        'Server-defined tool carries an input_schema',
        `Tools identified by "type" are defined by Anthropic and take no schema of yours. Remove input_schema from "${name}".`,
      );
    }
    return;
  }

  const expectedType = typeof tool['name'] === 'string' ? ANTHROPIC_DEFINED.get(tool['name']) : undefined;
  if (expectedType) {
    at(
      'error',
      `"${name}" is the name of an Anthropic-defined tool`,
      `A custom tool with your own schema named "${name}" is a different tool from the built-in one, and the model will not treat it as built-in. Declare {"type": "${expectedType}", "name": "${name}"} with no input_schema, or rename yours.`,
    );
  }

  // --- Required fields ----------------------------------------------------
  if (typeof tool['name'] !== 'string' || tool['name'].length === 0) {
    at('error', 'Missing name', 'Every custom tool needs a name.');
  } else if (!NAME_PATTERN.test(tool['name'])) {
    at(
      'error',
      'Invalid tool name',
      'Names may contain letters, digits, underscores and hyphens, up to 128 characters.',
    );
  }

  const description = tool['description'];
  if (typeof description !== 'string' || description.trim().length === 0) {
    at(
      'error',
      'Missing description',
      'The model decides when to call a tool almost entirely from its description. Without one it will call this tool unpredictably or not at all.',
    );
  } else if (description.trim().length < 30) {
    at(
      'warning',
      'Very short description',
      'Describe what the tool does, when to use it, when not to, and what it returns. This is the highest-leverage text in the whole definition.',
    );
  }

  const schema = tool['input_schema'];
  if (!isObject(schema)) {
    at('error', 'Missing input_schema', 'A custom tool needs an input_schema object.');
    return;
  }
  if (schema['type'] !== 'object') {
    at(
      'error',
      'input_schema must be an object schema',
      `Tool arguments are always a JSON object, so input_schema.type has to be "object"${typeof schema['type'] === 'string' ? `, not "${schema['type']}"` : ''}.`,
    );
  }
  if (!isObject(schema['properties'])) {
    at(
      'warning',
      'No properties declared',
      'A tool with no properties takes no arguments. That is valid, but usually means the schema was not filled in.',
    );
  }

  // --- Strict mode --------------------------------------------------------
  if (tool['strict'] === true) {
    if (schema['additionalProperties'] !== false) {
      at(
        'error',
        'strict requires additionalProperties: false',
        'Strict tool use guarantees the arguments validate exactly, which the API only accepts when the schema is closed.',
      );
    }
    if (!Array.isArray(schema['required'])) {
      at(
        'error',
        'strict requires a required array',
        'Add a "required" array to input_schema, even if it is empty.',
      );
    }
    if (Array.isArray(tool['allowed_callers'])) {
      at(
        'error',
        'strict is not compatible with programmatic tool calling',
        'A tool with allowed_callers cannot also set strict: true.',
      );
    }
  }

  if (isObject(schema['properties']) && Array.isArray(schema['required'])) {
    const properties = Object.keys(schema['properties']);
    for (const required of schema['required']) {
      if (typeof required === 'string' && !properties.includes(required)) {
        at(
          'error',
          `"${required}" is required but not declared`,
          'Every entry in "required" has to name a property that exists in "properties".',
        );
      }
    }
  }

  // --- Description coverage ----------------------------------------------
  if (isObject(schema['properties'])) {
    const undescribed = Object.entries(schema['properties'])
      .filter(([, value]) => !isObject(value) || typeof value['description'] !== 'string')
      .map(([key]) => key);
    if (undescribed.length > 0) {
      at(
        'info',
        `${undescribed.length} propert${undescribed.length === 1 ? 'y has' : 'ies have'} no description`,
        `The model reads per-property descriptions when filling arguments. Undescribed: ${undescribed.join(', ')}.`,
      );
    }
  }
}

export function lintToolDefinitions(input: unknown): Finding[] {
  const findings: Finding[] = [];

  // Accept a single tool, an array, or a whole request body with a tools array.
  let tools: unknown[];
  if (Array.isArray(input)) {
    tools = input;
  } else if (isObject(input) && Array.isArray(input['tools'])) {
    tools = input['tools'];
    if (input['mcp_servers'] !== undefined) {
      const hasToolset = (input['tools'] as unknown[]).some(
        (t) => isObject(t) && t['type'] === 'mcp_toolset',
      );
      if (!hasToolset) {
        findings.push({
          severity: 'error',
          title: 'mcp_servers without an mcp_toolset entry',
          detail:
            'Declaring mcp_servers alone is rejected as a validation error. Add {"type": "mcp_toolset", "mcp_server_name": "<the same name>"} to tools.',
        });
      }
    }
  } else if (isObject(input)) {
    tools = [input];
  } else {
    return [
      {
        severity: 'error',
        title: 'Not a tool definition',
        detail: 'Paste a tool definition, an array of them, or a request body containing a "tools" array.',
      },
    ];
  }

  if (tools.length === 0) {
    return [{ severity: 'error', title: 'No tools found', detail: 'The tools array is empty.' }];
  }

  const names = new Set<string>();
  for (const [index, tool] of tools.entries()) {
    if (!isObject(tool)) {
      findings.push({
        severity: 'error',
        title: `tools[${index}] is not an object`,
        detail: 'Each entry in the tools array must be a tool definition object.',
      });
      continue;
    }
    if (typeof tool['name'] === 'string') {
      if (names.has(tool['name'])) {
        findings.push({
          severity: 'error',
          title: `Duplicate tool name "${tool['name']}"`,
          detail: 'Tool names must be unique within a request.',
          tool: tool['name'],
        });
      }
      names.add(tool['name']);
    }
    lintOne(tool, index, findings);
  }

  // --- Whole-request rules -------------------------------------------------
  const deferred = tools.filter((t) => isObject(t) && t['defer_loading'] === true);
  if (deferred.length > 0) {
    if (deferred.length === tools.length) {
      findings.push({
        severity: 'error',
        title: 'Every tool is deferred',
        detail:
          'At least one tool must be non-deferred, or the API returns 400 "All tools have defer_loading set". The tool-search tool itself must never be deferred.',
      });
    }
    const searchDeferred = tools.some(
      (t) =>
        isObject(t) &&
        typeof t['type'] === 'string' &&
        t['type'].startsWith('tool_search_tool_') &&
        t['defer_loading'] === true,
    );
    if (searchDeferred) {
      findings.push({
        severity: 'error',
        title: 'The tool-search tool is itself deferred',
        detail: 'It has to be loaded for the model to search anything. Remove defer_loading from it.',
      });
    }
  }

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}
