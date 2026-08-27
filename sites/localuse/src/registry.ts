import { createRegistry } from '@tools/core';
import { brand } from './brand.js';
import { sections } from './sections.js';

export const registry = createRegistry(brand, sections);
