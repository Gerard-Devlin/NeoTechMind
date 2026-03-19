import type { APIRoute } from 'astro'

import { searchPublishedContent } from '@/lib/server/content.mjs'

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  })
}

export const GET: APIRoute = async ({ url }) => {
  const query = String(url.searchParams.get('q') || '').trim()
  const limit = Number(url.searchParams.get('limit') || 12)

  if (!query) {
    return json({ ok: true, query: '', results: [] })
  }

  try {
    const results = await searchPublishedContent(query, limit)
    return json({ ok: true, query, results })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Search failed'
    return json({ ok: false, message }, 500)
  }
}
