import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { brand } from './src/brand.js';

// Static output: every tool is a pre-rendered page, which is the entire SEO
// strategy. The interactive part is a React island on top of that HTML.
export default defineConfig({
  site: brand.origin,
  output: 'static',
  integrations: [react()],
  vite: { plugins: [tailwindcss()] },
  build: { inlineStylesheets: 'auto' },
});
