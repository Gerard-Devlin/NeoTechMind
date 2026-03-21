import { basename, extname } from 'node:path'

import type { APIRoute } from 'astro'

import { getSessionFromCookies } from '@/lib/server/auth.mjs'
import { getContentById, registerUploadedMedia, slugifyText } from '@/lib/server/content.mjs'

const MIME_BY_EXT: Record<string, string> = {
  '.apng': 'image/apng',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.gz': 'application/gzip',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.md': 'text/markdown',
  '.mdx': 'text/markdown',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rar': 'application/vnd.rar',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed'
}

const MAX_UPLOAD_SIZE = 100 * 1024 * 1024

function resolveMimeType(file: File) {
  if (file.type) return file.type
  const ext = extname(String(file.name || '')).toLowerCase()
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

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
    return json({ ok: false, message: 'Please select a file.' }, 400)
  }

  if (!sectionLabel) {
    return json({ ok: false, message: 'Course name is required.' }, 400)
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    return json({ ok: false, message: 'File is too large (max 100MB).' }, 400)
  }

  const resolvedMimeType = resolveMimeType(file)

  try {
    const sectionKey = slugifyText(sectionLabel) || 'uncategorized'
    const originalName = basename(file.name || 'upload.bin')
    const ext = extname(originalName).toLowerCase()
    const base = originalName.slice(0, Math.max(0, originalName.length - ext.length))
    const finalName = `${Date.now()}-${slugifyText(base) || 'upload'}${ext || '.bin'}`
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
      mimeType: resolvedMimeType,
      sizeBytes: file.size,
      blobData: buffer,
      section: sectionKey,
      sectionLabel,
      ownerUserId: session.userId
    })

    return json({
      ok: true,
      path: publicPath,
      mimeType: resolvedMimeType,
      isImage: resolvedMimeType.startsWith('image/'),
      originalName
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upload failed'
    return json({ ok: false, message }, 500)
  }
}
