import { ToolRunner } from '@tools/ui';
import { registry } from '../registry';

const createWorker = () =>
  new Worker(new URL('../tool-worker.ts', import.meta.url), { type: 'module' });

/**
 * The island boundary. Astro can only pass serialisable props and a tool
 * definition carries a function, so the island resolves the tool by id itself.
 */
export default function ToolIsland({ toolId }: { toolId: string }) {
  const tool = registry.allTools().find((t) => t.id === toolId);
  if (!tool) return <p className="text-rose-400">Unknown tool: {toolId}</p>;
  return <ToolRunner tool={tool} createWorker={createWorker} />;
}
