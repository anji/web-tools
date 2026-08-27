import { serveToolRequests } from '@tools/core';
import { registry } from './registry.js';

// Keeps very large documents off the main thread. The shell falls back to
// running inline when a worker cannot be created.
serveToolRequests(registry, self as unknown as DedicatedWorkerGlobalScope);
