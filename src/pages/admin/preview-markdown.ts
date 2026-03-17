import type { APIRoute } from 'astro'

import { getSessionFromCookies } from '@/lib/server/auth.mjs'
import { renderMarkdown } from '@/lib/server/markdown.mjs'

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    }
  })
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const session = await getSessionFromCookies(cookies)
  if (!session) {
    return json({ ok: false, message: 'Unauthorized' }, 401)
  }

  const payload = await request.json().catch(() => null)
  if (!payload || typeof payload !== 'object') {
    return json({ ok: false, message: 'Invalid payload' }, 400)
  }

  const content = typeof payload.content === 'string' ? payload.content : ''
  if (content.length > 2_000_000) {
    return json({ ok: false, message: 'Content too large for preview' }, 413)
  }

  try {
    const rendered = await renderMarkdown(content)
    return json({
      ok: true,
      html: rendered.html,
      hasMermaid: rendered.hasMermaid
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Preview render failed'
    return json({ ok: false, message }, 500)
  }
}

