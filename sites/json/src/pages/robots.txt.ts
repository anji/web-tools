import type { APIRoute } from 'astro';
import { registry } from '../registry';

export const GET: APIRoute = () =>
  new Response(
    `User-agent: *\nAllow: /\n\nSitemap: ${registry.brand.origin}/sitemap.xml\n`,
    { headers: { 'Content-Type': 'text/plain' } },
  );
