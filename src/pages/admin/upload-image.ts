import { basename, extname } from 'node:path'

import type { APIRoute } from 'astro'

import { getSessionFromCookies } from '@/lib/server/auth.mjs'
import { getContentById, registerUploadedMedia, slugifyText } from '@/lib/server/content.mjs'

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const session = await getSessionFromCookies(cookies)
  if (!session) {
    return json({ ok: false, message: 'Unauthorized' }, 401)
  }

  const formData = await request.formData().catch(() => null)
  if (!formData) {
    return json({ ok: false, message: 'Invalid form payload' }, 400)
  }

  const file = formData.get('file')
  const sectionLabel = String(formData.get('sectionLabel') || '').trim()
  const contentIdRaw = String(formData.get('contentId') || '').trim()

  if (!(file instanceof File) || file.size <= 0) {
    return json({ ok: false, message: 'Please select an image file.' }, 400)
  }

  if (!sectionLabel) {
    return json({ ok: false, message: 'Course name is required.' }, 400)
  }

  if (file.type && !file.type.startsWith('image/')) {
    return json({ ok: false, message: 'Only image uploads are supported.' }, 400)
  }

  try {
    const sectionKey = slugifyText(sectionLabel) || 'uncategorized'
    const originalName = basename(file.name || 'upload.png')
    const ext = extname(originalName).toLowerCase()
    const base = originalName.slice(0, Math.max(0, originalName.length - ext.length))
    const finalName = `${Date.now()}-${slugifyText(base) || 'upload'}${ext || '.png'}`
    const publicPath = `/uploads/${sectionKey}/${finalName}`

    const buffer = Buffer.from(await file.arrayBuffer())
    const contentId =
      contentIdRaw && Number.isInteger(Number(contentIdRaw)) && Number(contentIdRaw) > 0
        ? Number(contentIdRaw)
        : null
    let safeContentId: number | null = null
    if (contentId !== null) {
      const linked = await getContentById(contentId, session)
      safeContentId = linked?.id ? Number(linked.id) : null
    }

    await registerUploadedMedia({
      contentId: safeContentId,
      filePath: publicPath,
      originalName,
      mimeType: file.type || 'image/*',
      sizeBytes: file.size,
      blobData: buffer,
      section: sectionKey,
      sectionLabel,
      ownerUserId: session.userId
    })

    return json({ ok: true, path: publicPath })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upload failed'
    return json({ ok: false, message }, 500)
  }
}
