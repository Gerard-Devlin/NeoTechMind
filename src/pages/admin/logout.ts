import type { APIRoute } from 'astro'

import { ADMIN_COOKIE, destroySession } from '@/lib/server/auth.mjs'

export const GET: APIRoute = async ({ cookies, redirect }) => {
  const token = cookies.get(ADMIN_COOKIE)?.value
  if (token) {
    await destroySession(token)
  }
  cookies.delete(ADMIN_COOKIE, { path: '/' })
  return redirect('/admin/login')
}
