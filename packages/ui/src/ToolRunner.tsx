import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createToolClient,
  defaultOptions,
  type OptionValues,
  type Result,
  type ToolDefinition,
  type ToolError,
  type ToolOutput,
} from '@tools/core';

import { InputPane } from './components/InputPane.js';
import { OutputPane } from './components/OutputPane.js';
import { OptionsBar } from './components/OptionsBar.js';

interface Props {
  tool: ToolDefinition<any>;
  /**
   * Sites with heavyweight tools pass a worker factory so large inputs do not
   * block the main thread. Omitted, the tool runs inline, which is fine for the
   * text-sized work the JSON site does.
   */
  createWorker?: () => Worker;
}

/** Long enough to skip a keystroke, short enough to feel live. */
const DEBOUNCE_MS = 180;
/** Past this, run in a worker if one is available rather than blocking paint. */
const INLINE_LIMIT = 200_000;

export function ToolRunner({ tool, createWorker }: Props) {
  const [inputs, setInputs] = useState<string[]>(() => tool.inputs.map(() => ''));
  const [values, setValues] = useState<OptionValues>(() => defaultOptions(tool));
  const [output, setOutput] = useState<ToolOutput | undefined>();
  const [error, setError] = useState<ToolError | undefined>();
  const [busy, setBusy] = useState(false);

  const client = useMemo(() => {
    if (!createWorker) return undefined;
    try {
      return createToolClient(createWorker());
    } catch {
      // A blocked worker (strict CSP, older browser) is not fatal -- fall back
      // to running inline rather than showing the user a broken tool.
      return undefined;
    }
  }, [createWorker]);

  useEffect(() => () => client?.dispose(), [client]);

  // Guards against an out-of-order worker reply overwriting a newer result.
  const generation = useRef(0);

  const apply = useCallback((result: Result<ToolOutput>) => {
    if (result.ok) {
      setOutput(result.value);
      setError(undefined);
    } else {
      setOutput(undefined);
      setError(result.error);
    }
  }, []);

  useEffect(() => {
    const empty = inputs.every((text) => text.trim().length === 0);
    if (empty) {
      setOutput(undefined);
      setError(undefined);
      setBusy(false);
      return;
    }

    const run = generation.current + 1;
    generation.current = run;
    const total = inputs.reduce((sum, text) => sum + text.length, 0);

    const timer = setTimeout(() => {
      if (client && total > INLINE_LIMIT) {
        setBusy(true);
        void client.run(tool.id, inputs, values).then((result) => {
          if (generation.current !== run) return;
          setBusy(false);
          apply(result);
        });
        return;
      }

      try {
        apply(tool.run(inputs, values));
      } catch (e) {
        // A tool that throws is a bug, but the page should still be usable.
        setOutput(undefined);
        setError({
          message: e instanceof Error ? e.message : String(e),
          hint: 'This looks like a bug in the tool rather than a problem with your input.',
        });
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [inputs, values, tool, client, apply]);

  const setInput = useCallback((index: number, text: string) => {
    setInputs((current) => current.map((existing, i) => (i === index ? text : existing)));
  }, []);

  const onOptionChange = useCallback((key: string, value: string | number | boolean) => {
    setValues((current) => ({ ...current, [key]: value }));
  }, []);

  const onFileError = useCallback((message: string) => {
    setOutput(undefined);
    setError({ message });
  }, []);

  return (
    <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900/60">
      <OptionsBar options={tool.options ?? []} values={values} onChange={onOptionChange} />

      <div className="grid divide-y divide-slate-800 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        <div className="flex min-h-0 flex-col divide-y divide-slate-800">
          {tool.inputs.map((spec, index) => (
            <InputPane
              key={spec.label}
              spec={spec}
              value={inputs[index] ?? ''}
              onChange={(text) => setInput(index, text)}
              onError={onFileError}
            />
          ))}
        </div>
        <OutputPane output={output} error={error} busy={busy} />
      </div>
    </div>
  );
}
