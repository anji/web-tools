import { describe, it, expect } from 'vitest';
import { csvTools } from '../src/index.js';
import { defaultOptions } from '@tools/core';

/**
 * The engines are pure functions with no DOM and no network, so they run
 * outside a browser unchanged. That is what makes a CLI, a library or an MCP
 * server a packaging exercise rather than a rewrite.
 */
describe('engines run headless', () => {
  it('runs a CSV tool with no browser globals present', () => {
    expect(typeof globalThis.document).toBe('undefined');
    const tool = csvTools.find((t) => t.id === 'csv-to-sql')!;
    const result = tool.run(["id,name\n1,Ada\n2,O'Brien"], defaultOptions(tool));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toContain('CREATE TABLE');
    expect(result.value.content).toContain("'O''Brien'");
  });
});
