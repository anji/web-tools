import type { Result } from './result.js';

/**
 * Declarative option descriptors. Tools describe their options as data so the
 * shared <ToolShell> can render the controls generically -- adding tool #40
 * should not mean writing tool #40's settings UI.
 */
export type ToolOption =
  | { kind: 'boolean'; key: string; label: string; default: boolean; help?: string }
  | {
      kind: 'select';
      key: string;
      label: string;
      choices: ReadonlyArray<{ value: string; label: string }>;
      default: string;
      help?: string;
    }
  | {
      kind: 'number';
      key: string;
      label: string;
      default: number;
      min?: number;
      max?: number;
      step?: number;
      help?: string;
    }
  | { kind: 'text'; key: string; label: string; default: string; placeholder?: string; help?: string };

export type OptionValues = Record<string, string | number | boolean>;

/** Syntax-highlighting hint for the output pane. */
export type OutputLanguage =
  | 'json'
  | 'typescript'
  | 'yaml'
  | 'csv'
  | 'sql'
  | 'text'
  | 'diff'
  | 'markdown';

export interface ToolOutput {
  content: string;
  language: OutputLanguage;
  /** Suggested filename for the download button. */
  filename: string;
  /** Small chips rendered above the output, e.g. "4 interfaces", "-38% size". */
  stats?: ReadonlyArray<{ label: string; value: string }>;
  /** Non-fatal notes, e.g. "3 keys were not valid TS identifiers and were quoted". */
  warnings?: readonly string[];
}

export interface ToolInputSpec {
  label: string;
  placeholder?: string;
  language: OutputLanguage;
  /** File extensions accepted by the drop zone, e.g. ['.json', '.txt']. */
  accept?: readonly string[];
}

export interface ToolSeo {
  /** <title>. Keep under ~60 chars. */
  title: string;
  /** <meta name="description">. Keep under ~155 chars. */
  description: string;
  /** H1 on the tool page -- often differs from the nav label. */
  heading: string;
  /** Intro paragraph rendered under the H1, before the tool. */
  intro: string;
  /** Long-tail phrases this page should rank for. Rendered as FAQ/related links. */
  keywords: readonly string[];
  /** Rendered as FAQPage JSON-LD, which is what actually wins the SERP real estate. */
  faq?: ReadonlyArray<{ question: string; answer: string }>;
}

export interface ToolDefinition<O extends OptionValues = OptionValues> {
  id: string;
  /** URL segment. The whole SEO strategy is one indexable page per slug. */
  slug: string;
  /** Short label for nav and cards. */
  label: string;
  /** One-line description for tool cards. */
  blurb: string;
  category: string;
  seo: ToolSeo;
  /** Most tools take one input; diff-style tools take two. */
  inputs: readonly [ToolInputSpec] | readonly [ToolInputSpec, ToolInputSpec];
  options?: readonly ToolOption[];
  /**
   * Pure function. No network, no globals, no DOM -- which is what lets us run
   * it in a worker, test it in node, and honestly promise nothing is uploaded.
   */
  run(inputs: readonly string[], options: O): Result<ToolOutput>;
}

/** Identity helper that pins the generic so option keys stay inferred. */
export function defineTool<O extends OptionValues = OptionValues>(
  def: ToolDefinition<O>,
): ToolDefinition<O> {
  return def;
}

/** Pulls the declared defaults out of an option list. */
export function defaultOptions(def: Pick<ToolDefinition<any>, 'options'>): OptionValues {
  const values: OptionValues = {};
  for (const opt of def.options ?? []) values[opt.key] = opt.default;
  return values;
}

/** Typed readers so tools can pull option values without casting at each use. */
export const readBoolean = (o: OptionValues, key: string, fallback: boolean): boolean =>
  typeof o[key] === 'boolean' ? (o[key] as boolean) : fallback;

export const readString = (o: OptionValues, key: string, fallback: string): string =>
  typeof o[key] === 'string' ? (o[key] as string) : fallback;

export const readNumber = (o: OptionValues, key: string, fallback: number): number =>
  typeof o[key] === 'number' && Number.isFinite(o[key]) ? (o[key] as number) : fallback;
