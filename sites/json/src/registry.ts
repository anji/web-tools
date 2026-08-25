import { createRegistry } from '@tools/core';
import { jsonTools } from '@tools/json';
import { brand } from './brand.js';

export const registry = createRegistry(brand, jsonTools);
