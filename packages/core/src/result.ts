/**
 * Every tool returns a Result rather than throwing. Tool code runs on user data
 * that is frequently malformed -- that is the whole point of the product -- so a
 * parse failure is an ordinary outcome we render, not an exception we swallow.
 */
export type Result<T, E = ToolError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface ToolError {
  message: string;
  /** 1-indexed line in the input, when the failure can be located. */
  line?: number;
  /** 1-indexed column in the input, when the failure can be located. */
  column?: number;
  /** Character offset into the input. */
  offset?: number;
  /** Short actionable hint shown under the error message. */
  hint?: string;
}

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = (error: ToolError | string): Result<never, ToolError> => ({
  ok: false,
  error: typeof error === 'string' ? { message: error } : error,
});

/** Wraps a throwing function so unexpected failures still surface as Results. */
export function attempt<T>(fn: () => T, hint?: string): Result<T, ToolError> {
  try {
    return ok(fn());
  } catch (e) {
    return err({
      message: e instanceof Error ? e.message : String(e),
      ...(hint ? { hint } : {}),
    });
  }
}
