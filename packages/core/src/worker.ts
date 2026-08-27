import type { OptionValues, ToolOutput } from './tool.js';
import type { Result } from './result.js';
import type { SiteRegistry } from './registry.js';

/**
 * Tool functions are pure, but they are not structured-cloneable, so we cannot
 * ship the function to a worker. Instead each site bundles one worker that
 * imports its own registry and dispatches by tool id.
 */

export interface ToolRequest {
  requestId: number;
  toolId: string;
  inputs: readonly string[];
  options: OptionValues;
}

export interface ToolResponse {
  requestId: number;
  result: Result<ToolOutput>;
}

/** Worker side: wire a registry up to `self.onmessage`. */
export function serveToolRequests(registry: SiteRegistry, scope: DedicatedWorkerGlobalScope): void {
  scope.onmessage = (event: MessageEvent<ToolRequest>) => {
    const { requestId, toolId, inputs, options } = event.data;
    const tool = registry.allTools().find((t) => t.id === toolId);
    const result: Result<ToolOutput> = tool
      ? tool.run(inputs, options)
      : { ok: false, error: { message: `Unknown tool: ${toolId}` } };
    const response: ToolResponse = { requestId, result };
    scope.postMessage(response);
  };
}

/**
 * Main-thread side. Keeps the UI responsive on large inputs, and cancels stale
 * work: while the user is typing, only the newest request's result matters.
 */
export function createToolClient(worker: Worker) {
  let nextId = 1;
  const pending = new Map<number, (result: Result<ToolOutput>) => void>();

  worker.onmessage = (event: MessageEvent<ToolResponse>) => {
    const resolve = pending.get(event.data.requestId);
    if (resolve) {
      pending.delete(event.data.requestId);
      resolve(event.data.result);
    }
  };

  return {
    run(toolId: string, inputs: readonly string[], options: OptionValues): Promise<Result<ToolOutput>> {
      const requestId = nextId++;
      return new Promise((resolve) => {
        pending.set(requestId, resolve);
        worker.postMessage({ requestId, toolId, inputs, options } satisfies ToolRequest);
      });
    },
    /** Drops resolvers for superseded requests so their results are ignored. */
    abandonBefore(requestId: number): void {
      for (const id of pending.keys()) if (id < requestId) pending.delete(id);
    },
    dispose(): void {
      pending.clear();
      worker.terminate();
    },
  };
}
