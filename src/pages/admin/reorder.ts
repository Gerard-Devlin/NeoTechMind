import type { APIRoute } from 'astro'

import { getSessionFromCookies } from '@/lib/server/auth.mjs'
import { reorderCourseDocs, reorderCourseSections } from '@/lib/server/content.mjs'

export const POST: APIRoute = async ({ request, cookies }) => {
  const session = await getSessionFromCookies(cookies)
  if (!session) {
    return new Response(JSON.stringify({ ok: false, message: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    })
  }

  const payload = await request.json().catch(() => null)
  if (!payload || typeof payload !== 'object') {
    return new Response(JSON.stringify({ ok: false, message: 'Invalid payload' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    })
  }

  if (payload.type === 'courses' && Array.isArray(payload.order)) {
    try {
      await reorderCourseSections(payload.order, session)
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' }
      })
    } catch (error) {
      return new Response(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : 'Forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      })
    }
  }

  if (payload.type === 'docs' && typeof payload.sectionKey === 'string' && Array.isArray(payload.order)) {
    await reorderCourseDocs(payload.sectionKey, payload.order, session)
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' }
    })
  }

  return new Response(JSON.stringify({ ok: false, message: 'Unsupported reorder request' }), {
    status: 400,
    headers: { 'content-type': 'application/json' }
  })
}
