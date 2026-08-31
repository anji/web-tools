import { ok, err } from '@tools/core';
import type { Result } from '@tools/core';

/** Local JSON parse with a hint tuned to what gets pasted here. */
export function parseJson(text: string): Result<unknown> {
  if (text.trim().length === 0) {
    return err({ message: 'Nothing to read yet.', hint: 'Paste some JSON to get started.' });
  }
  try {
    return ok(JSON.parse(text) as unknown);
  } catch (e) {
    return err({
      message: e instanceof Error ? e.message.replace(/\s*in JSON at position \d+.*$/i, '') : String(e),
      hint: 'A trailing comma or an unquoted key is the usual cause when copying from source code rather than from a response.',
    });
  }
}
