import type { APIRoute } from 'astro'

import { getMediaBinaryByPath } from '@/lib/server/content.mjs'

function buildPath(path = '') {
  const normalized = String(path || '')
    .split('/')
    .map((segment) => decodeURIComponent(segment))
    .filter(Boolean)
    .join('/')
  return normalized ? `/imports/techmind/${normalized}` : '/imports/techmind/'
}

export const GET: APIRoute = async ({ params }) => {
  const filePath = buildPath(params.path)
  const media = await getMediaBinaryByPath(filePath)

  if (!media?.blob_data) {
    return new Response('Not Found', { status: 404 })
  }

  const payload = new Uint8Array(media.blob_data)

  return new Response(payload, {
    status: 200,
    headers: {
      'content-type': media.mime_type || 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      'content-length': String(media.size_bytes || payload.length || 0)
    }
  })
}
