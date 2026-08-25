import { parse as parseYamlText, stringify as stringifyYaml } from 'yaml';
import { ok, err } from '@tools/core';
import type { Result } from '@tools/core';

export interface YamlOptions {
  indent: number;
  /** Wrap long scalars. 0 disables wrapping, which is usually what people want. */
  lineWidth: number;
  /** Emit `---` at the top of the document. */
  documentStart: boolean;
  /** Always quote strings rather than letting YAML decide. */
  quoteStrings: boolean;
}

export const defaultYamlOptions: YamlOptions = {
  indent: 2,
  lineWidth: 0,
  documentStart: false,
  quoteStrings: false,
};

export function jsonToYaml(value: unknown, options: YamlOptions): Result<string> {
  try {
    const text = stringifyYaml(value, {
      indent: options.indent,
      lineWidth: options.lineWidth,
      defaultStringType: options.quoteStrings ? 'QUOTE_DOUBLE' : 'PLAIN',
      defaultKeyType: 'PLAIN',
    });
    return ok(options.documentStart ? `---\n${text}` : text);
  } catch (e) {
    return err({
      message: e instanceof Error ? e.message : String(e),
      hint: 'Some JSON values (very deep nesting, exotic keys) do not round-trip cleanly to YAML.',
    });
  }
}

export function yamlToJson(text: string): Result<unknown> {
  if (text.trim().length === 0) {
    return err({ message: 'Nothing to convert yet.', hint: 'Paste or drop some YAML to get started.' });
  }
  try {
    return ok(parseYamlText(text) as unknown);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // The yaml package reports "at line X, column Y"; keep it, it is accurate.
    const at = /at line (\d+), column (\d+)/.exec(message);
    return {
      ok: false,
      error: {
        message: message.split('\n')[0] ?? message,
        ...(at?.[1] && at[2] ? { line: Number(at[1]), column: Number(at[2]) } : {}),
        hint: 'YAML is indentation sensitive. Mixed tabs and spaces are the usual culprit.',
      },
    };
  }
}
