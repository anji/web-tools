import type { OptionValues, ToolOption } from '@tools/core';

interface Props {
  options: readonly ToolOption[];
  values: OptionValues;
  onChange: (key: string, value: string | number | boolean) => void;
}

const label = 'text-xs font-medium text-slate-400';

/**
 * Renders a tool's controls straight from its declared options. Adding a tool
 * should never mean writing its settings UI by hand.
 */
export function OptionsBar({ options, values, onChange }: Props) {
  if (options.length === 0) return null;

  return (
    <div className="flex flex-wrap items-end gap-x-5 gap-y-3 border-b border-slate-800 bg-slate-900/40 px-4 py-3">
      {options.map((option) => {
        const value = values[option.key];

        if (option.kind === 'boolean') {
          return (
            <label key={option.key} className="flex cursor-pointer items-center gap-2" title={option.help}>
              <input
                type="checkbox"
                checked={value === true}
                onChange={(e) => onChange(option.key, e.target.checked)}
                className="h-4 w-4 cursor-pointer rounded border-slate-600 bg-slate-800 text-sky-500 focus:ring-1 focus:ring-sky-500"
              />
              <span className="text-xs font-medium text-slate-300">{option.label}</span>
            </label>
          );
        }

        if (option.kind === 'select') {
          return (
            <div key={option.key} className="flex flex-col gap-1" title={option.help}>
              <span className={label}>{option.label}</span>
              <select
                value={String(value ?? option.default)}
                onChange={(e) => onChange(option.key, e.target.value)}
                className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
              >
                {option.choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </div>
          );
        }

        if (option.kind === 'number') {
          return (
            <div key={option.key} className="flex flex-col gap-1" title={option.help}>
              <span className={label}>{option.label}</span>
              <input
                type="number"
                value={typeof value === 'number' ? value : option.default}
                min={option.min}
                max={option.max}
                step={option.step}
                onChange={(e) => onChange(option.key, Number(e.target.value))}
                className="w-24 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
              />
            </div>
          );
        }

        return (
          <div key={option.key} className="flex flex-col gap-1" title={option.help}>
            <span className={label}>{option.label}</span>
            <input
              type="text"
              value={typeof value === 'string' ? value : option.default}
              placeholder={option.placeholder}
              onChange={(e) => onChange(option.key, e.target.value)}
              className="w-44 rounded border border-slate-700 bg-slate-800 px-2 py-1 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
            />
          </div>
        );
      })}
    </div>
  );
}
