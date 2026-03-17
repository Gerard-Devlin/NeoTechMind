import type { APIRoute } from 'astro'

import { getSessionFromCookies, isAdminSession } from '@/lib/server/auth.mjs'
import { hideCourseSection } from '@/lib/server/content.mjs'

export const POST: APIRoute = async ({ request, cookies }) => {
  const session = await getSessionFromCookies(cookies)
  if (!session) {
    return new Response(JSON.stringify({ ok: false, message: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    })
  }

  if (!isAdminSession(session)) {
    return new Response(JSON.stringify({ ok: false, message: 'Only admin can hide courses.' }), {
      status: 403,
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

  try {
    const result = await hideCourseSection(payload.sectionKey, session)
    return new Response(JSON.stringify({ ok: true, data: result }), {
      headers: { 'content-type': 'application/json' }
    })
  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, message: error instanceof Error ? error.message : 'Hide failed' }),
      {
        status: 400,
        headers: { 'content-type': 'application/json' }
      }
    )
  }
}
