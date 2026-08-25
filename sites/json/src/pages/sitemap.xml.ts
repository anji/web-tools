import type { APIRoute } from 'astro';
import { registry } from '../registry';

export const GET: APIRoute = () => {
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...registry.urls().map((url) => `  <url><loc>${url}</loc></url>`),
    '</urlset>',
  ].join('\n');

  return new Response(body, { headers: { 'Content-Type': 'application/xml' } });
};
