import type { APIRoute } from 'astro'

import { getSessionFromCookies } from '@/lib/server/auth.mjs'
import { deleteContentById } from '@/lib/server/content.mjs'

export const POST: APIRoute = async ({ cookies, params, redirect }) => {
  const session = await getSessionFromCookies(cookies)
  if (!session) {
    return redirect('/admin/login')
  }

  const id = Number(params.id)
  if (Number.isFinite(id)) {
    try {
      await deleteContentById(id, session)
    } catch {
      return new Response('Forbidden', { status: 403 })
    }
  }

  return redirect('/admin?deleted=1')
}
