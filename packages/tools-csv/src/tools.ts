import {
  defineTool,
  ok,
  readBoolean,
  readNumber,
  readString,
  type OptionValues,
  type Result,
  type ToolOutput,
} from '@tools/core';
import {
  emitTypeScript, defaultTypeScriptOptions,
  emitZod, defaultZodOptions,
  emitJsonSchema, defaultJsonSchemaOptions,
  emitGo, defaultGoOptions,
  emitCSharp, defaultCSharpOptions,
  emitPython, defaultPythonOptions,
  emitJava, defaultJavaOptions,
  emitRust, defaultRustOptions,
} from '@tools/codegen';

import { parseCsv, defaultParseOptions, normaliseRow, type ParseResult } from './parse.js';
import {
  inferColumns, inferTableSchema, coerceRow, defaultInferOptions, type InferOptions,
} from './infer.js';
import { toSql, defaultSqlOptions, type Dialect } from './to-sql.js';
import { profileColumns, findDuplicateRows, renderProfile } from './analyze.js';

const CSV_INPUT = {
  label: 'CSV',
  placeholder:
    'id,name,email,score,status\n1,Ada,ada@example.com,90.5,active\n2,Grace,grace@example.com,,archived',
  language: 'csv' as const,
  accept: ['.csv', '.tsv', '.txt'] as const,
};

const PRIVACY_FAQ = {
  question: 'Is my file uploaded anywhere?',
  answer:
    'No. Parsing happens in your browser as a pure function, and the page is served with a Content-Security-Policy of connect-src ‘none’, so the browser refuses to let it open a network connection at all. That is what makes it safe to drop a real export — the kind with customer names and email addresses in it.',
};

const MESSY_FAQ = {
  question: 'My file has commas inside quoted fields. Will it break?',
  answer:
    'No. The parser handles quoted delimiters, newlines inside quoted fields, doubled quotes, a UTF-8 BOM, semicolon and tab delimiters, and lone-CR line endings from old Mac exports. It also reports rows whose field count does not match the header instead of quietly dropping them.',
};

const ZEROS_FAQ = {
  question: 'Why is my zip code column a string rather than a number?',
  answer:
    'Because a leading zero carries meaning. 01234 parsed as a number becomes 1234, and the zip code is gone. Any value with a leading zero stays a string, as do integers beyond the range JavaScript can represent exactly — which is where snowflake ids and long account numbers live.',
};

/** Shared parse + infer step; every tool starts here. */
function prepare(input: string, options: OptionValues) {
  const parsed = parseCsv(input, {
    ...defaultParseOptions,
    delimiter: readString(options, 'delimiter', ''),
    header: readString(options, 'header', 'auto') === 'auto'
      ? 'auto'
      : readBoolean(options, 'header', true),
    trimFields: readBoolean(options, 'trimFields', false),
    maxRows: readNumber(options, 'maxRows', 10000),
  });
  if (!parsed.ok) return parsed;

  const inferOptions: InferOptions = {
    ...defaultInferOptions,
    nullTokens: readString(options, 'nullTokens', defaultInferOptions.nullTokens),
    inferEnums: readBoolean(options, 'inferEnums', true),
  };
  return ok({ parsed: parsed.value, columns: inferColumns(parsed.value, inferOptions), inferOptions });
}

const DELIMITER_OPTION = {
  kind: 'select' as const,
  key: 'delimiter',
  label: 'Delimiter',
  choices: [
    { value: '', label: 'Detect' },
    { value: ',', label: 'Comma' },
    { value: ';', label: 'Semicolon' },
    { value: '\t', label: 'Tab' },
    { value: '|', label: 'Pipe' },
  ],
  default: '',
};

const HEADER_OPTION = {
  kind: 'select' as const,
  key: 'header',
  label: 'Header row',
  choices: [
    { value: 'auto', label: 'Detect' },
    { value: 'true', label: 'Yes' },
    { value: 'false', label: 'No' },
  ],
  default: 'auto',
};

const ROWS_OPTION = {
  kind: 'number' as const,
  key: 'maxRows',
  label: 'Row limit',
  default: 10000,
  min: 100,
  max: 200000,
  step: 1000,
  help: 'Keeps the tab responsive on very large files.',
};

const statsFor = (parsed: ParseResult) => {
  const stats = [
    { label: 'rows', value: parsed.rowCount.toLocaleString() },
    { label: 'columns', value: String(parsed.headers.length) },
    { label: 'delimiter', value: parsed.delimiter === '\t' ? 'tab' : parsed.delimiter },
  ];
  if (parsed.raggedRows.length > 0) {
    stats.push({ label: 'ragged rows', value: String(parsed.raggedRows.length) });
  }
  return stats;
};

const warningsFor = (parsed: ParseResult): string[] => {
  const warnings: string[] = [];
  if (parsed.truncated) {
    warnings.push(`Stopped at the row limit. Raise it to process the whole file.`);
  }
  if (parsed.raggedRows.length > 0) {
    const first = parsed.raggedRows[0]!;
    warnings.push(
      `${parsed.raggedRows.length} row${parsed.raggedRows.length === 1 ? '' : 's'} do not match the header width — first at line ${first.line}, ${first.got} fields instead of ${first.expected}. Short rows are padded and long ones trimmed.`,
    );
  }
  if (parsed.lineEnding === 'mixed') {
    warnings.push('The file mixes line endings, which some tools downstream will object to.');
  }
  return warnings;
};

// ---------------------------------------------------------------------------

const toJsonTool = defineTool({
  id: 'csv-to-json',
  slug: 'csv-to-json',
  label: 'CSV → JSON',
  blurb: 'Convert to JSON with column types inferred, not everything stringified.',
  category: 'Convert',
  seo: {
    title: 'CSV to JSON Converter - Typed Output, Nothing Uploaded',
    description:
      'Convert CSV to JSON in your browser. Infers real column types instead of quoting everything, keeps leading zeros intact, handles quoted delimiters and BOMs, and never uploads your file.',
    heading: 'CSV to JSON',
    intro:
      'Drop a CSV and get JSON with real types — numbers as numbers, blanks as null, booleans as booleans. Columns whose leading zeros matter stay strings, because a zip code that becomes 1234 is a bug, not a conversion.',
    keywords: ['csv to json', 'convert csv to json', 'csv to json online', 'csv json converter', 'tsv to json'],
    faq: [PRIVACY_FAQ, MESSY_FAQ, ZEROS_FAQ, {
      question: 'Can I keep every value as a string?',
      answer:
        'Yes — turn off type detection and every cell comes back quoted. That is the right choice when something downstream re-parses the values itself and you want the original text preserved exactly.',
    }],
  },
  inputs: [CSV_INPUT] as const,
  options: [
    DELIMITER_OPTION,
    HEADER_OPTION,
    { kind: 'boolean', key: 'detectTypes', label: 'Infer types', default: true, help: 'Off keeps every value a string.' },
    { kind: 'boolean', key: 'minify', label: 'Minify', default: false },
    { kind: 'boolean', key: 'trimFields', label: 'Trim whitespace', default: false },
    { kind: 'text', key: 'nullTokens', label: 'Null tokens', default: defaultInferOptions.nullTokens, placeholder: 'NULL,N/A' },
    ROWS_OPTION,
  ],
  run(inputs, options): Result<ToolOutput> {
    const prepared = prepare(inputs[0] ?? '', options);
    if (!prepared.ok) return prepared;
    const { parsed, columns, inferOptions } = prepared.value;

    const typed = readBoolean(options, 'detectTypes', true);
    const records = parsed.rows.map((row) => {
      if (typed) return coerceRow(row, columns, inferOptions);
      const normalised = normaliseRow(row, parsed.headers.length);
      return Object.fromEntries(parsed.headers.map((h, i) => [h, normalised[i] ?? '']));
    });

    const content = readBoolean(options, 'minify', false)
      ? JSON.stringify(records)
      : JSON.stringify(records, null, 2) + '\n';

    return ok({
      content,
      language: 'json',
      filename: 'data.json',
      stats: statsFor(parsed),
      warnings: warningsFor(parsed),
    });
  },
});

const toSqlTool = defineTool({
  id: 'csv-to-sql',
  slug: 'csv-to-sql',
  label: 'CSV → SQL',
  blurb: 'Generate CREATE TABLE and INSERT statements with types inferred per dialect.',
  category: 'Convert',
  seo: {
    title: 'CSV to SQL - CREATE TABLE and INSERT Generator, No Upload',
    description:
      'Turn a CSV into a CREATE TABLE plus batched INSERT statements for PostgreSQL, MySQL or SQLite. Column types and NOT NULL are inferred from the data. Runs entirely in your browser.',
    heading: 'CSV to SQL',
    intro:
      'Drop a CSV and get a table definition and the inserts to fill it. Column types are inferred per dialect, NOT NULL is applied where the data has no gaps, and values are escaped properly rather than concatenated.',
    keywords: ['csv to sql', 'csv to insert statements', 'csv to create table', 'csv to postgres', 'generate sql from csv'],
    faq: [PRIVACY_FAQ, ZEROS_FAQ, {
      question: 'How are the column types chosen?',
      answer:
        'From the values, per dialect. Integers become BIGINT (INTEGER on SQLite), decimals DOUBLE PRECISION, detected timestamps TIMESTAMPTZ or DATETIME, UUIDs a native UUID column on Postgres and CHAR(36) on MySQL. On MySQL a bounded string becomes VARCHAR rather than TEXT so it can be indexed.',
    }, {
      question: 'Are the values escaped safely?',
      answer:
        'Single quotes are doubled, nulls emitted as NULL rather than an empty string, and numbers and booleans written unquoted in each dialect’s form. That said, generated SQL is for loading data you already have — do not build a habit of concatenating untrusted input into statements.',
    }],
  },
  inputs: [CSV_INPUT] as const,
  options: [
    { kind: 'text', key: 'tableName', label: 'Table name', default: 'my_table', placeholder: 'my_table' },
    {
      kind: 'select', key: 'dialect', label: 'Dialect',
      choices: [
        { value: 'postgres', label: 'PostgreSQL' },
        { value: 'mysql', label: 'MySQL' },
        { value: 'sqlite', label: 'SQLite' },
      ],
      default: 'postgres',
    },
    DELIMITER_OPTION,
    { kind: 'boolean', key: 'createTable', label: 'CREATE TABLE', default: true },
    { kind: 'boolean', key: 'insertRows', label: 'INSERT rows', default: true },
    { kind: 'boolean', key: 'dropIfExists', label: 'DROP IF EXISTS', default: false },
    { kind: 'boolean', key: 'inferNotNull', label: 'Infer NOT NULL', default: true },
    { kind: 'number', key: 'batchSize', label: 'Rows per INSERT', default: 100, min: 1, max: 1000, step: 10 },
    ROWS_OPTION,
  ],
  run(inputs, options): Result<ToolOutput> {
    const prepared = prepare(inputs[0] ?? '', options);
    if (!prepared.ok) return prepared;
    const { parsed, columns, inferOptions } = prepared.value;

    const dialectRaw = readString(options, 'dialect', 'postgres');
    const dialect: Dialect =
      dialectRaw === 'mysql' || dialectRaw === 'sqlite' ? dialectRaw : 'postgres';

    const nullTokens = new Set(
      inferOptions.nullTokens.split(',').map((t) => t.trim()).filter(Boolean),
    );

    const result = toSql(columns, parsed.rows, nullTokens, {
      ...defaultSqlOptions,
      dialect,
      tableName: readString(options, 'tableName', 'my_table'),
      createTable: readBoolean(options, 'createTable', true),
      insertRows: readBoolean(options, 'insertRows', true),
      dropIfExists: readBoolean(options, 'dropIfExists', false),
      inferNotNull: readBoolean(options, 'inferNotNull', true),
      batchSize: readNumber(options, 'batchSize', 100),
    });

    return ok({
      content: result.sql,
      language: 'sql',
      filename: 'import.sql',
      stats: [...statsFor(parsed), { label: 'statements', value: String(result.statements) }],
      warnings: warningsFor(parsed),
    });
  },
});

const toCodeTool = defineTool({
  id: 'csv-to-code',
  slug: 'csv-to-code',
  label: 'CSV → types',
  blurb: 'Generate TypeScript, Go, Rust, Python, Java, C# or Zod types from the columns.',
  category: 'Code generation',
  seo: {
    title: 'CSV to TypeScript, Go, Rust and More - Type Generator',
    description:
      'Generate typed structs and models from a CSV header and data: TypeScript, Zod, Go, Rust, Python, Java, C# and JSON Schema. Nullable columns map to each language’s own idiom. No upload.',
    heading: 'CSV to Types',
    intro:
      'Drop a CSV and get types for the language you actually use. Columns with blanks become nullable in each language’s own way — a pointer in Go, Option in Rust, str | None in Python — because that is the difference between a clean load and a crash on row 4,000.',
    keywords: [
      'csv to typescript',
      'csv to go struct',
      'csv to rust struct',
      'csv to python dataclass',
      'generate types from csv',
    ],
    faq: [PRIVACY_FAQ, ZEROS_FAQ, {
      question: 'How does it decide a column is nullable?',
      answer:
        'A column with any empty cell — or one holding a token like NULL or N/A — is nullable, and every generator expresses that in its own idiom rather than a shared approximation: string | null in TypeScript, *string in Go, Option<String> in Rust, str | None in Python, string? in C#, a boxed type in Java.',
    }, {
      question: 'Why did a column become a union of literals?',
      answer:
        'Because it looked like an enum: a small set of distinct values, each appearing many times. A status column with three values across a thousand rows is far more useful typed as those three values than as a bare string. Turn off enum detection if you would rather it stayed open.',
    }],
  },
  inputs: [CSV_INPUT] as const,
  options: [
    {
      kind: 'select', key: 'language', label: 'Language',
      choices: [
        { value: 'typescript', label: 'TypeScript' },
        { value: 'zod', label: 'Zod' },
        { value: 'go', label: 'Go' },
        { value: 'rust', label: 'Rust' },
        { value: 'python', label: 'Python' },
        { value: 'java', label: 'Java' },
        { value: 'csharp', label: 'C#' },
        { value: 'json-schema', label: 'JSON Schema' },
      ],
      default: 'typescript',
    },
    { kind: 'text', key: 'rootName', label: 'Row type name', default: 'Row', placeholder: 'Row' },
    DELIMITER_OPTION,
    { kind: 'boolean', key: 'inferEnums', label: 'Detect enums', default: true },
    ROWS_OPTION,
  ],
  run(inputs, options): Result<ToolOutput> {
    const prepared = prepare(inputs[0] ?? '', options);
    if (!prepared.ok) return prepared;
    const { parsed, columns } = prepared.value;

    const schema = inferTableSchema(columns);
    const language = readString(options, 'language', 'typescript');

    // The emitters take the name of the *collection* and singularise it for the
    // element type. This option asks for the row type, so pluralise before
    // handing it over — otherwise someone who types Row gets a struct called
    // RowItem and an alias called Row, which is the wrong way round.
    const rowName = readString(options, 'rootName', 'Row') || 'Row';
    const rootName = /s$/i.test(rowName) ? rowName : `${rowName}s`;

    const emitted = (() => {
      switch (language) {
        case 'zod':
          return { ...emitZod(schema, { ...defaultZodOptions, rootName }), file: 'schema.ts', lang: 'typescript' as const };
        case 'go':
          return { ...emitGo(schema, { ...defaultGoOptions, rootName }), file: 'types.go', lang: 'text' as const };
        case 'rust':
          return { ...emitRust(schema, { ...defaultRustOptions, rootName }), file: 'models.rs', lang: 'text' as const };
        case 'python':
          return { ...emitPython(schema, { ...defaultPythonOptions, rootName }), file: 'models.py', lang: 'text' as const };
        case 'java':
          return { ...emitJava(schema, { ...defaultJavaOptions, rootName }), file: 'Models.java', lang: 'text' as const };
        case 'csharp':
          return { ...emitCSharp(schema, { ...defaultCSharpOptions, rootName }), file: 'Models.cs', lang: 'text' as const };
        case 'json-schema':
          return { ...emitJsonSchema(schema, { ...defaultJsonSchemaOptions, rootName }), file: 'schema.json', lang: 'json' as const };
        default:
          return { ...emitTypeScript(schema, { ...defaultTypeScriptOptions, rootName }), file: 'types.ts', lang: 'typescript' as const };
      }
    })();

    return ok({
      content: emitted.code,
      language: emitted.lang,
      filename: emitted.file,
      stats: statsFor(parsed),
      warnings: [...warningsFor(parsed), ...emitted.warnings],
    });
  },
});

const analyzerTool = defineTool({
  id: 'csv-analyze',
  slug: 'csv-analyzer',
  label: 'CSV analyzer',
  blurb: 'Profile every column: type, nulls, distinct values, ranges and bad rows.',
  category: 'Inspect',
  seo: {
    title: 'CSV Analyzer - Column Types, Nulls and Data Quality, No Upload',
    description:
      'Profile a CSV in your browser: inferred type per column, missing values, distinct counts, ranges, duplicate rows and rows with the wrong field count. Nothing is uploaded.',
    heading: 'CSV Analyzer',
    intro:
      'Drop a file and find out what is actually in it before you load it anywhere: what each column really holds, how much is missing, which rows are malformed, and whether there are duplicates.',
    keywords: ['csv analyzer', 'csv column types', 'csv data profiling', 'inspect csv online', 'csv statistics'],
    faq: [PRIVACY_FAQ, MESSY_FAQ, {
      question: 'What counts as a missing value?',
      answer:
        'An empty cell, plus the tokens listed in the options — NULL, N/A and similar by default. Exports differ on how they mark absence, so the list is editable rather than assumed.',
    }, {
      question: 'What are ragged rows?',
      answer:
        'Rows whose field count does not match the header, usually an unescaped delimiter inside a value or a broken export. They are reported with line numbers rather than silently padded, because that is normally the bug you came here to find.',
    }],
  },
  inputs: [CSV_INPUT] as const,
  options: [
    DELIMITER_OPTION,
    HEADER_OPTION,
    { kind: 'text', key: 'nullTokens', label: 'Null tokens', default: defaultInferOptions.nullTokens, placeholder: 'NULL,N/A' },
    ROWS_OPTION,
  ],
  run(inputs, options): Result<ToolOutput> {
    const prepared = prepare(inputs[0] ?? '', options);
    if (!prepared.ok) return prepared;
    const { parsed, columns, inferOptions } = prepared.value;

    const nullTokens = new Set(
      inferOptions.nullTokens.split(',').map((t) => t.trim()).filter(Boolean),
    );
    const profiles = profileColumns(parsed, columns, nullTokens);
    const duplicates = findDuplicateRows(parsed);

    return ok({
      content: renderProfile(parsed, profiles, duplicates),
      language: 'text',
      filename: 'profile.txt',
      stats: [
        ...statsFor(parsed),
        { label: 'duplicates', value: String(duplicates) },
      ],
      warnings: parsed.truncated ? ['Only the first rows were read; raise the row limit for a full profile.'] : [],
    });
  },
});

export const csvTools = [toJsonTool, toSqlTool, toCodeTool, analyzerTool];
