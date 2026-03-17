import { basename, extname } from 'node:path'

import {
  dbAll,
  dbGet,
  dbRun,
  hydrateContentRow,
  normalizeNavPath,
  normalizeTags,
  nowIso,
  ready
} from './db.mjs'

const SECTION_ORDER = ['C', 'Python', 'DSA', 'DLD', 'DBS', 'COA', 'ML&DL']
const textCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
let sectionCleanupPromise = null

function normalizeUserId(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeActor(actor) {
  if (!actor) return null
  const userId = normalizeUserId(actor.userId ?? actor.id)
  const role = String(actor.role || '').toLowerCase() === 'admin' ? 'admin' : 'editor'
  return {
    userId,
    role,
    isAdmin: role === 'admin'
  }
}

function actorCanManageRecord(actor, record) {
  const normalizedActor = normalizeActor(actor)
  if (!normalizedActor) return true
  if (normalizedActor.isAdmin) return true
  const ownerId = normalizeUserId(record?.created_by_user_id)
  return ownerId !== null && ownerId === normalizedActor.userId
}

function filterDocsByActor(docs, actor) {
  const normalizedActor = normalizeActor(actor)
  if (!normalizedActor || normalizedActor.isAdmin) return docs
  return docs.filter((doc) => normalizeUserId(doc.created_by_user_id) === normalizedActor.userId)
}

function normalizePathname(pathname) {
  const normalized = String(pathname || '/').trim()
  if (!normalized || normalized === '/') return '/'
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

function normalizeSectionName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

const uploadPublicPrefix = '/uploads/'
const importPublicPrefix = '/imports/techmind/'
const mediaPrefixes = [uploadPublicPrefix, importPublicPrefix]

const extensionToMimeType = {
  '.apng': 'image/apng',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf'
}

function normalizeMediaPath(value) {
  const raw = String(value || '').trim()
  let clean = raw.split('#')[0].split('?')[0]
  while (/[),.;]$/.test(clean)) {
    clean = clean.slice(0, -1)
  }
  if (!clean) return ''
  return mediaPrefixes.some((prefix) => clean.startsWith(prefix)) ? clean : ''
}

function normalizeUploadPath(value) {
  const normalized = normalizeMediaPath(value)
  if (!normalized.startsWith(uploadPublicPrefix)) return ''
  return normalized
}

function extractMediaPaths(content, heroImage = '') {
  const paths = new Set()
  const collect = (value) => {
    const text = String(value || '')
    const matches = text.match(/\/(?:uploads|imports\/techmind)\/[^\s"']+/g) || []
    for (const match of matches) {
      const normalized = normalizeMediaPath(match)
      if (normalized) paths.add(normalized)
    }
  }

  collect(content)
  collect(heroImage)
  return [...paths]
}

function buildSectionUploadPath(sourcePath, sectionKey) {
  const normalizedSource = normalizeUploadPath(sourcePath)
  if (!normalizedSource) return ''
  const fileName = basename(normalizedSource)
  const safeSection = slugifyText(sectionKey || 'uncategorized') || 'uncategorized'
  return `${uploadPublicPrefix}${safeSection}/${fileName}`
}

async function ensureUniqueUploadPath(preferredPath) {
  const normalized = normalizeUploadPath(preferredPath)
  if (!normalized) return ''

  const existingDbPath = await dbGet(
    `SELECT id
     FROM media_files
     WHERE file_path = ?
     LIMIT 1`,
    [normalized]
  )

  if (!existingDbPath) {
    return normalized
  }

  const extMatch = normalized.match(/(\.[^.\\/]+)$/)
  const ext = extMatch ? extMatch[1] : ''
  const stem = ext ? normalized.slice(0, -ext.length) : normalized
  let attempt = 1
  while (attempt <= 50) {
    const candidate = `${stem}-${Date.now()}-${attempt}${ext}`
    const candidateDbPath = await dbGet(
      `SELECT id
       FROM media_files
       WHERE file_path = ?
       LIMIT 1`,
      [candidate]
    )
    if (!candidateDbPath) {
      return candidate
    }
    attempt += 1
  }

  return `${stem}-${Date.now()}${ext}`
}

function guessMimeType(filePath, fallback = 'application/octet-stream') {
  const extension = extname(String(filePath || '')).toLowerCase()
  return extensionToMimeType[extension] || fallback
}

function normalizeBinaryData(value) {
  if (!value) return null
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (Array.isArray(value)) return Buffer.from(value)
  if (typeof value === 'string') {
    if (value.startsWith('\\x')) {
      return Buffer.from(value.slice(2), 'hex')
    }
    const trimmed = value.trim()
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
      return Buffer.from(trimmed, 'hex')
    }
    return Buffer.from(value, 'base64')
  }
  return null
}

async function readFileSize(mediaPath) {
  const mediaPathNormalized = normalizeMediaPath(mediaPath)
  if (!mediaPathNormalized) return 0

  const mediaRow = await dbGet(
    `SELECT size_bytes
     FROM media_files
     WHERE file_path = ?
     LIMIT 1`,
    [mediaPathNormalized]
  )
  if (mediaRow?.size_bytes !== undefined && mediaRow?.size_bytes !== null) {
    return Number(mediaRow.size_bytes || 0)
  }

  return 0
}

async function upsertMediaFileBlob({ filePath, mimeType = null, blobData = null }) {
  const normalizedPath = normalizeMediaPath(filePath)
  if (!normalizedPath) return null

  let payload = normalizeBinaryData(blobData)
  if (!payload) {
    return null
  }

  const now = nowIso()
  const resolvedMimeType = mimeType || guessMimeType(normalizedPath)
  const sizeBytes = Number(payload.length || 0)

  const existing = await dbGet(
    `SELECT id
     FROM media_files
     WHERE file_path = ?
     LIMIT 1`,
    [normalizedPath]
  )

  if (existing?.id) {
    await dbRun(
      `UPDATE media_files
       SET mime_type = ?,
           size_bytes = ?,
           blob_data = ?,
           updated_at = ?
       WHERE id = ?`,
      [resolvedMimeType, sizeBytes, payload, now, Number(existing.id)]
    )

    return {
      id: Number(existing.id),
      file_path: normalizedPath,
      mime_type: resolvedMimeType,
      size_bytes: sizeBytes,
      blob_data: payload
    }
  }

  const inserted = await dbGet(
    `INSERT INTO media_files (
       file_path,
       mime_type,
       size_bytes,
       blob_data,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     RETURNING id`,
    [normalizedPath, resolvedMimeType, sizeBytes, payload, now, now]
  )

  return {
    id: Number(inserted?.id || 0),
    file_path: normalizedPath,
    mime_type: resolvedMimeType,
    size_bytes: sizeBytes,
    blob_data: payload
  }
}

async function ensureMediaFileBlobByPath(filePath) {
  const normalizedPath = normalizeMediaPath(filePath)
  if (!normalizedPath) return null

  const existing = await dbGet(
    `SELECT id, file_path, mime_type, size_bytes, blob_data
     FROM media_files
     WHERE file_path = ?
     LIMIT 1`,
    [normalizedPath]
  )
  if (existing?.id) {
    return {
      id: Number(existing.id),
      file_path: String(existing.file_path),
      mime_type: existing.mime_type ? String(existing.mime_type) : guessMimeType(normalizedPath),
      size_bytes: Number(existing.size_bytes || 0),
      blob_data: normalizeBinaryData(existing.blob_data)
    }
  }

  return upsertMediaFileBlob({ filePath: normalizedPath })
}

function compareSectionLabels(left, right) {
  const leftRank = SECTION_ORDER.indexOf(left)
  const rightRank = SECTION_ORDER.indexOf(right)

  if (leftRank !== -1 || rightRank !== -1) {
    if (leftRank === -1) return 1
    if (rightRank === -1) return -1
    return leftRank - rightRank
  }

  return textCollator.compare(left, right)
}

function compareSectionRecords(left, right) {
  const leftOrder = Number(left?.sort_order)
  const rightOrder = Number(right?.sort_order)

  if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) && leftOrder !== rightOrder) {
    return leftOrder - rightOrder
  }

  return compareSectionLabels(left?.label || '', right?.label || '')
}

function compareDatesDesc(left, right) {
  return new Date(right).getTime() - new Date(left).getTime()
}

function compareDocs(left, right) {
  const leftSectionOrder = Number(left.section_sort_order)
  const rightSectionOrder = Number(right.section_sort_order)
  const sectionCompare =
    Number.isFinite(leftSectionOrder) && Number.isFinite(rightSectionOrder) && leftSectionOrder !== rightSectionOrder
      ? leftSectionOrder - rightSectionOrder
      : compareSectionLabels(left.section_label || '', right.section_label || '')
  if (sectionCompare !== 0) return sectionCompare

  if (
    Number.isFinite(Number(left.nav_sequence)) &&
    Number.isFinite(Number(right.nav_sequence)) &&
    Number(left.nav_sequence) !== Number(right.nav_sequence)
  ) {
    return Number(left.nav_sequence) - Number(right.nav_sequence)
  }

  const leftPath = Array.isArray(left.navPath) ? left.navPath : []
  const rightPath = Array.isArray(right.navPath) ? right.navPath : []
  const parentCompare = textCollator.compare(
    leftPath.slice(1, -1).join('/'),
    rightPath.slice(1, -1).join('/')
  )
  if (parentCompare !== 0) return parentCompare

  const orderCompare = Number(left.nav_order ?? 999) - Number(right.nav_order ?? 999)
  if (orderCompare !== 0) return orderCompare

  const pathCompare = textCollator.compare(leftPath.join('/'), rightPath.join('/'))
  if (pathCompare !== 0) return pathCompare

  return textCollator.compare(left.title || '', right.title || '')
}

function buildDocUrl(doc) {
  return `/docs/${doc.slug}`
}

async function fetchCourseSections() {
  await ready
  await ensureCourseSectionIntegrity()

  const rows = await dbAll(
    `SELECT section_key, label, sort_order
     FROM course_sections
     ORDER BY sort_order ASC, label ASC`
  )

  return rows.map((row) => ({
    key: String(row.section_key),
    label: String(row.label),
    sort_order: Number(row.sort_order ?? 999)
  }))
}

async function ensureCourseSectionIntegrity() {
  if (!sectionCleanupPromise) {
    sectionCleanupPromise = (async () => {
      const rows = await dbAll(
        `SELECT section_key, label, sort_order
         FROM course_sections
         ORDER BY sort_order ASC, label ASC`
      )

      const grouped = new Map()
      for (const row of rows) {
        const normalized = normalizeSectionName(row.label)
        if (!normalized) continue
        if (!grouped.has(normalized)) {
          grouped.set(normalized, [])
        }
        grouped.get(normalized).push({
          key: String(row.section_key),
          label: String(row.label),
          sort_order: Number(row.sort_order ?? 999)
        })
      }

      for (const group of grouped.values()) {
        if (group.length <= 1) continue

        const canonicalSlug = slugifyText(group[0].label)
        const sorted = [...group].sort(compareSectionRecords)
        const canonical =
          sorted.find((section) => section.key === canonicalSlug) ||
          sorted[0]

        for (const duplicate of sorted) {
          if (duplicate.key === canonical.key) continue
          await dbRun(
            `UPDATE content_items
             SET section = ?, section_label = ?
             WHERE section = ?`,
            [canonical.key, canonical.label, duplicate.key]
          )
          await dbRun(`DELETE FROM course_sections WHERE section_key = ?`, [duplicate.key])
        }
      }
    })().finally(() => {
      sectionCleanupPromise = null
    })
  }

  await sectionCleanupPromise
}

function applySectionOrder(docs, sectionRecords) {
  const sectionMap = new Map(sectionRecords.map((section) => [section.key, section]))
  return docs.map((doc) => ({
    ...doc,
    section_sort_order: sectionMap.get(doc.section)?.sort_order ?? null
  }))
}

async function ensureCourseSection(sectionKey, label) {
  const existing = await dbGet(
    `SELECT section_key, label, sort_order
     FROM course_sections
     WHERE section_key = ?`,
    [sectionKey]
  )

  if (existing) {
    if (existing.label !== label) {
      await dbRun(`UPDATE course_sections SET label = ? WHERE section_key = ?`, [label, sectionKey])
    }
    return {
      key: String(existing.section_key),
      label: String(label),
      sort_order: Number(existing.sort_order ?? 999)
    }
  }

  const maxRow = await dbGet(`SELECT MAX(sort_order) AS max_sort_order FROM course_sections`)
  const nextOrder = Number(maxRow?.max_sort_order ?? -1) + 1

  await dbRun(
    `INSERT INTO course_sections (section_key, label, sort_order)
     VALUES (?, ?, ?)`,
    [sectionKey, label, nextOrder]
  )

  return {
    key: sectionKey,
    label,
    sort_order: nextOrder
  }
}

async function resolveCourseSectionKey(sectionLabel, requestedSection = '', current = null) {
  const normalizedLabel = normalizeSectionName(sectionLabel)
  if (!normalizedLabel) {
    return ''
  }

  const sections = await fetchCourseSections()
  const exactMatch = sections.find((section) => normalizeSectionName(section.label) === normalizedLabel)
  if (exactMatch) {
    return exactMatch.key
  }

  const currentMatches =
    current?.section &&
    normalizeSectionName(current.section_label) === normalizedLabel

  if (currentMatches) {
    return String(current.section)
  }

  const requested = String(requestedSection || '').trim()
  if (requested) {
    return requested
  }

  return slugifyText(sectionLabel)
}

function ensureDocNavPath(sectionLabel, navPath, title) {
  const path = normalizeNavPath(navPath)
  const safeSection = String(sectionLabel || '').trim() || 'Uncategorized'

  if (path.length === 0) {
    return [safeSection, String(title || '').trim() || 'Untitled']
  }

  if (path[0] === safeSection) {
    return path
  }

  return [safeSection, ...path]
}

function upsertNode(list, label, key) {
  let existing = list.find((item) => item.label === label)
  if (!existing) {
    existing = { label, key, children: [], item: null }
    list.push(existing)
  }
  return existing
}

export function slugifyText(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[\/\\]+/g, '-')
    .replace(/[^\p{Letter}\p{Number}\s_-]+/gu, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/(^-|-$)/g, '')
}

export function slugifyPathSegments(segments) {
  return normalizeNavPath(segments)
    .map((segment) => slugifyText(segment))
    .filter(Boolean)
    .join('/')
}

export function parseDelimitedList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function parseNavPathInput(value, fallbackTitle = '') {
  const raw = String(value || '').trim()
  if (!raw) return fallbackTitle ? [fallbackTitle] : []

  return raw
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
}

export function stripMarkdown(value) {
  return String(value || '')
    .replace(/^---[\s\S]*?---/m, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\(([^)]+)\)/g, ' ')
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_~|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildSummary(content, fallback = '') {
  const text = stripMarkdown(content)
  if (!text) return fallback
  return text.slice(0, 180)
}

function countRowValue(row) {
  const value = row?.count ?? row?.COUNT ?? row?.total ?? 0
  return Number(value || 0)
}

async function upsertContentMediaRecord({
  contentId = null,
  filePath,
  originalName = null,
  mimeType = null,
  sizeBytes = 0,
  section = null,
  sectionLabel = null,
  ownerUserId = null
}) {
  const normalizedPath = normalizeMediaPath(filePath)
  if (!normalizedPath) return null

  const now = nowIso()
  const safeSizeBytes = Number(sizeBytes || 0)
  const parsedContentId =
    contentId === null || contentId === undefined || String(contentId).trim() === ''
      ? null
      : Number(contentId)
  const normalizedContentId =
    Number.isInteger(parsedContentId) && Number(parsedContentId) > 0 ? Number(parsedContentId) : null
  const normalizedOwnerUserId = normalizeUserId(ownerUserId)

  const existing = normalizedContentId
    ? await dbGet(
        `SELECT id
         FROM content_media
         WHERE content_id = ? AND file_path = ?
         LIMIT 1`,
        [normalizedContentId, normalizedPath]
      )
    : await dbGet(
        `SELECT id
         FROM content_media
         WHERE content_id IS NULL AND file_path = ?
         LIMIT 1`,
        [normalizedPath]
      )

  if (!existing?.id && normalizedContentId) {
    const orphan = await dbGet(
      `SELECT id
       FROM content_media
       WHERE content_id IS NULL AND file_path = ?
       LIMIT 1`,
      [normalizedPath]
    )
    if (orphan?.id) {
      await dbRun(
        `UPDATE content_media
         SET content_id = ?,
             original_name = ?,
             mime_type = ?,
             size_bytes = ?,
             section = ?,
             section_label = ?,
             owner_user_id = ?,
             updated_at = ?
         WHERE id = ?`,
        [
          normalizedContentId,
          originalName,
          mimeType,
          safeSizeBytes,
          section,
          sectionLabel,
          normalizedOwnerUserId,
          now,
          Number(orphan.id)
        ]
      )
      return Number(orphan.id)
    }
  }

  if (existing?.id) {
    await dbRun(
      `UPDATE content_media
       SET original_name = ?,
           mime_type = ?,
           size_bytes = ?,
           section = ?,
           section_label = ?,
           owner_user_id = ?,
           updated_at = ?
       WHERE id = ?`,
      [originalName, mimeType, safeSizeBytes, section, sectionLabel, normalizedOwnerUserId, now, Number(existing.id)]
    )
    return Number(existing.id)
  }

  const inserted = await dbGet(
    `INSERT INTO content_media (
       content_id,
       file_path,
       original_name,
       mime_type,
       size_bytes,
       section,
       section_label,
       owner_user_id,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    [
      normalizedContentId,
      normalizedPath,
      originalName,
      mimeType,
      safeSizeBytes,
      section,
      sectionLabel,
      normalizedOwnerUserId,
      now,
      now
    ]
  )

  return Number(inserted?.id || 0)
}

async function syncContentMediaLinks(record) {
  if (!record?.id || record.type !== 'doc') return record

  let nextContent = String(record.content || '')
  let nextHeroImage = normalizeMediaPath(record.hero_image || '') || String(record.hero_image || '')
  const sectionKey = String(record.section || '').trim() || 'uncategorized'
  const sectionLabel = String(record.section_label || '').trim() || 'Uncategorized'
  const ownerUserId = normalizeUserId(record.created_by_user_id)

  const referencedPaths = extractMediaPaths(nextContent, nextHeroImage)
  const movedPaths = new Map()

  for (const sourcePath of referencedPaths) {
    const uploadPath = normalizeUploadPath(sourcePath)
    if (!uploadPath) continue

    const desiredPath = buildSectionUploadPath(uploadPath, sectionKey)
    if (!desiredPath || desiredPath === sourcePath) continue

    const otherRefs = await dbGet(
      `SELECT COUNT(*) AS count
       FROM content_media
       WHERE file_path = ? AND content_id IS NOT NULL AND content_id != ?`,
      [sourcePath, record.id]
    )
    if (countRowValue(otherRefs) > 0) {
      continue
    }

    const uniqueDesiredPath = await ensureUniqueUploadPath(desiredPath)
    movedPaths.set(sourcePath, uniqueDesiredPath)
  }

  if (movedPaths.size > 0) {
    for (const [oldPath, newPath] of movedPaths.entries()) {
      nextContent = nextContent.split(oldPath).join(newPath)
      if (nextHeroImage === oldPath) {
        nextHeroImage = newPath
      }
      await dbRun(
        `UPDATE content_media
         SET file_path = ?,
             section = ?,
             section_label = ?,
             owner_user_id = ?,
             updated_at = ?
         WHERE content_id = ? AND file_path = ?`,
        [newPath, sectionKey, sectionLabel, ownerUserId, nowIso(), record.id, oldPath]
      )
      await dbRun(
        `UPDATE media_files
         SET file_path = ?,
             updated_at = ?
         WHERE file_path = ?`,
        [newPath, nowIso(), oldPath]
      )
    }
  }

  if (nextContent !== String(record.content || '') || nextHeroImage !== String(record.hero_image || '')) {
    await dbRun(
      `UPDATE content_items
       SET content = ?, hero_image = ?, updated_at = ?
       WHERE id = ?`,
      [nextContent, nextHeroImage || null, nowIso(), record.id]
    )
  }

  const finalPaths = extractMediaPaths(nextContent, nextHeroImage)
  const existingRows = await dbAll(
    `SELECT id, file_path
     FROM content_media
     WHERE content_id = ?`,
    [record.id]
  )
  const existingMap = new Map(existingRows.map((row) => [String(row.file_path), Number(row.id)]))

  for (const mediaPath of finalPaths) {
    const blob = await ensureMediaFileBlobByPath(mediaPath)
    await upsertContentMediaRecord({
      contentId: record.id,
      filePath: mediaPath,
      mimeType: blob?.mime_type || null,
      sizeBytes: blob?.size_bytes ?? (await readFileSize(mediaPath)),
      section: sectionKey,
      sectionLabel,
      ownerUserId
    })
    existingMap.delete(mediaPath)
  }

  for (const [obsoletePath, mediaId] of existingMap.entries()) {
    const otherRefs = await dbGet(
      `SELECT COUNT(*) AS count
       FROM content_media
       WHERE file_path = ? AND (content_id IS NULL OR content_id != ?)`,
      [obsoletePath, record.id]
    )
    await dbRun(`DELETE FROM content_media WHERE id = ?`, [mediaId])
    if (countRowValue(otherRefs) > 0) continue

    await dbRun(`DELETE FROM media_files WHERE file_path = ?`, [obsoletePath])
  }

  const updated = await getContentById(record.id)
  if (!updated) return null
  return updated
}

async function fetchContent(type, includeDraft = false) {
  await ready

  const rows = includeDraft
    ? await dbAll(
        `SELECT * FROM content_items
         WHERE type = ?
         ORDER BY COALESCE(published_at, updated_at) DESC, id DESC`,
        [type]
      )
    : await dbAll(
        `SELECT * FROM content_items
         WHERE type = ? AND status = 'published'
         ORDER BY COALESCE(published_at, updated_at) DESC, id DESC`,
        [type]
      )

  return rows.map(hydrateContentRow)
}

function serializeContentInput(input, current = null) {
  const createdAt = current?.created_at || nowIso()
  const updatedAt = nowIso()
  const type = input.type === 'blog' ? 'blog' : 'doc'
  const status = input.status === 'published' ? 'published' : 'draft'
  const title = String(input.title || '').trim()
  const sourcePath = input.sourcePath || current?.source_path || null
  const heroImage = input.heroImage || current?.hero_image || null
  const subtitle = String(input.subtitle || current?.subtitle || '').trim() || null
  const tags = normalizeTags(input.tags)
  const navOrder = Number.isFinite(Number(input.navOrder))
    ? Number(input.navOrder)
    : Number(current?.nav_order ?? 999)
  const navSequence = Number.isFinite(Number(input.navSequence))
    ? Number(input.navSequence)
    : current?.nav_sequence ?? null
  const publishedAt =
    input.publishedAt || (status === 'published' ? current?.published_at || nowIso() : null)
  const ownerUserId =
    normalizeUserId(input.ownerUserId) ??
    normalizeUserId(current?.created_by_user_id) ??
    null

  if (type === 'doc') {
    const sectionLabel = String(input.sectionLabel || current?.section_label || '').trim() || 'Uncategorized'
    const section = String(input.section || current?.section || '').trim() || slugifyText(sectionLabel)
    const navPath = ensureDocNavPath(sectionLabel, input.navPath, title)
    const slug = String(input.slug || '').trim() || current?.slug || slugifyPathSegments(navPath)

    return {
      id: current?.id || input.id || undefined,
      type,
      title,
      slug,
      subtitle,
      summary: String(input.summary || '').trim() || buildSummary(input.content, ''),
      content: String(input.content || '').replace(/\r\n/g, '\n'),
      status,
      tags: JSON.stringify(tags),
      hero_image: heroImage,
      source_path: sourcePath,
      section,
      section_label: sectionLabel,
      nav_path: JSON.stringify(navPath),
      nav_order: navOrder,
      nav_sequence: navSequence,
      created_by_user_id: ownerUserId,
      created_at: createdAt,
      updated_at: updatedAt,
      published_at: publishedAt,
      is_imported: Boolean(input.isImported)
    }
  }

  const slug = String(input.slug || '').trim() || current?.slug || slugifyText(title)

  return {
    id: current?.id || input.id || undefined,
    type,
    title,
    slug,
    subtitle,
    summary: String(input.summary || '').trim() || buildSummary(input.content, ''),
    content: String(input.content || '').replace(/\r\n/g, '\n'),
    status,
    tags: JSON.stringify(tags),
    hero_image: heroImage,
    source_path: sourcePath,
    section: null,
    section_label: null,
    nav_path: JSON.stringify(normalizeNavPath(input.navPath)),
    nav_order: navOrder,
    nav_sequence: navSequence,
    created_by_user_id: ownerUserId,
    created_at: createdAt,
    updated_at: updatedAt,
    published_at: publishedAt,
    is_imported: Boolean(input.isImported)
  }
}

export async function listAdminContent(actor) {
  const docs = await fetchContent('doc', true)
  const sections = await fetchCourseSections()
  return applySectionOrder(filterDocsByActor(docs, actor), sections).sort(compareDocs)
}

export async function getAdminCourseOptions(actor) {
  const docs = filterDocsByActor(await fetchContent('doc', true), actor)
  const sections = await fetchCourseSections()
  const sectionMap = new Map(sections.map((section) => [section.key, section]))

  return [...new Set(docs.map((doc) => doc.section_label).filter(Boolean))].sort((left, right) =>
    compareSectionRecords(
      sectionMap.get(slugifyText(left)) || { label: left, sort_order: Number.MAX_SAFE_INTEGER },
      sectionMap.get(slugifyText(right)) || { label: right, sort_order: Number.MAX_SAFE_INTEGER }
    )
  )
}

export async function listRecentMedia(limit = 30, actor) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 30))
  const normalizedActor = normalizeActor(actor)
  const rows =
    normalizedActor && !normalizedActor.isAdmin
      ? await dbAll(
          `SELECT id, content_id, file_path, original_name, mime_type, size_bytes, section, section_label, created_at, updated_at
           FROM content_media
           WHERE owner_user_id = ?
           ORDER BY updated_at DESC, id DESC
           LIMIT ?`,
          [normalizedActor.userId, safeLimit]
        )
      : await dbAll(
          `SELECT id, content_id, file_path, original_name, mime_type, size_bytes, section, section_label, created_at, updated_at
           FROM content_media
           ORDER BY updated_at DESC, id DESC
           LIMIT ?`,
          [safeLimit]
        )

  return rows.map((row) => ({
    id: Number(row.id),
    content_id: row.content_id === null || row.content_id === undefined ? null : Number(row.content_id),
    file_path: String(row.file_path),
    original_name: row.original_name ? String(row.original_name) : '',
    mime_type: row.mime_type ? String(row.mime_type) : '',
    size_bytes: Number(row.size_bytes || 0),
    section: row.section ? String(row.section) : '',
    section_label: row.section_label ? String(row.section_label) : '',
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || '')
  }))
}

export async function registerUploadedMedia(input) {
  const normalizedPath = normalizeMediaPath(input?.filePath || '')
  if (!normalizedPath) return null

  const blob = await upsertMediaFileBlob({
    filePath: normalizedPath,
    mimeType: input?.mimeType || null,
    blobData: input?.blobData || null
  })

  return upsertContentMediaRecord({
    contentId: input?.contentId ?? null,
    filePath: normalizedPath,
    originalName: input?.originalName || null,
    mimeType: blob?.mime_type || input?.mimeType || null,
    sizeBytes: Number(input?.sizeBytes || blob?.size_bytes || 0),
    section: input?.section || null,
    sectionLabel: input?.sectionLabel || null,
    ownerUserId: input?.ownerUserId ?? null
  })
}

export async function storeMediaBlob(input) {
  const normalizedPath = normalizeMediaPath(input?.filePath || '')
  if (!normalizedPath) return null

  return upsertMediaFileBlob({
    filePath: normalizedPath,
    mimeType: input?.mimeType || null,
    blobData: input?.blobData || null
  })
}

export async function getMediaBinaryByPath(filePath) {
  const normalizedPath = normalizeMediaPath(filePath)
  if (!normalizedPath) return null

  const existing = await dbGet(
    `SELECT file_path, mime_type, size_bytes, blob_data
     FROM media_files
     WHERE file_path = ?
     LIMIT 1`,
    [normalizedPath]
  )

  if (existing?.blob_data) {
    return {
      file_path: String(existing.file_path),
      mime_type: existing.mime_type ? String(existing.mime_type) : guessMimeType(normalizedPath),
      size_bytes: Number(existing.size_bytes || 0),
      blob_data: normalizeBinaryData(existing.blob_data)
    }
  }

  return null
}

export async function backfillMediaFilesFromContent() {
  const rows = await dbAll(
    `SELECT id, content, hero_image
     FROM content_items
     WHERE type = 'doc'`
  )
  const allPaths = new Set()

  for (const row of rows) {
    for (const path of extractMediaPaths(row.content, row.hero_image)) {
      allPaths.add(path)
    }
  }

  let synced = 0
  for (const filePath of allPaths) {
    const media = await ensureMediaFileBlobByPath(filePath)
    if (media?.id) synced += 1
  }

  return {
    total: allPaths.size,
    synced
  }
}

export async function getAdminDashboardData(actor) {
  const docs = await listAdminContent(actor)
  const sectionRecords = await fetchCourseSections()
  const sectionMap = new Map(sectionRecords.map((section) => [section.key, section]))
  const courses = new Map()

  for (const doc of docs) {
    const key = doc.section || slugifyText(doc.section_label || 'uncategorized')
    if (!courses.has(key)) {
      courses.set(key, {
        key,
        label: doc.section_label || 'Uncategorized',
        docs: [],
        updatedAt: doc.updated_at,
        sortOrder: sectionMap.get(key)?.sort_order ?? null
      })
    }

    const course = courses.get(key)
    course.docs.push(doc)
    if (new Date(doc.updated_at).getTime() > new Date(course.updatedAt).getTime()) {
      course.updatedAt = doc.updated_at
    }
  }

  return [...courses.values()].sort((left, right) =>
    compareSectionRecords(
      { key: left.key, label: left.label, sort_order: left.sortOrder },
      { key: right.key, label: right.label, sort_order: right.sortOrder }
    )
  )
}

export async function getContentById(id, actor) {
  const row = await dbGet('SELECT * FROM content_items WHERE id = ?', [id])
  const hydrated = hydrateContentRow(row)
  if (!hydrated) return null
  if (!actorCanManageRecord(actor, hydrated)) return null
  return hydrated
}

export async function getContentBySlug(type, slug, includeDraft = false) {
  const row = includeDraft
    ? await dbGet('SELECT * FROM content_items WHERE type = ? AND slug = ?', [type, slug])
    : await dbGet(
        `SELECT * FROM content_items
         WHERE type = ? AND slug = ? AND status = 'published'`,
        [type, slug]
      )

  return hydrateContentRow(row)
}

export async function getBlogPage(page = 1, pageSize = 10) {
  const safePage = Math.max(1, Number(page) || 1)
  const safePageSize = Math.max(1, Number(pageSize) || 10)
  const countRow = await dbGet(
    `SELECT COUNT(*) AS count FROM content_items WHERE type = 'blog' AND status = 'published'`
  )
  const total = Number(countRow?.count || 0)

  const entries = (
    await dbAll(
      `SELECT * FROM content_items
       WHERE type = 'blog' AND status = 'published'
       ORDER BY COALESCE(published_at, updated_at) DESC, id DESC
       LIMIT ? OFFSET ?`,
      [safePageSize, (safePage - 1) * safePageSize]
    )
  ).map(hydrateContentRow)

  return {
    entries,
    page: safePage,
    pageSize: safePageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / safePageSize))
  }
}

export async function getRecentContent(type, limit = 5) {
  return (await fetchContent(type, false)).slice(0, limit)
}

export async function getArchiveGroups() {
  const rows = await fetchContent('blog', false)
  const groups = new Map()

  for (const row of rows) {
    const year = new Date(row.published_at || row.updated_at).getFullYear()
    if (!groups.has(year)) groups.set(year, [])
    groups.get(year).push(row)
  }

  return [...groups.entries()]
}

export async function getSectionDocs(sectionKey, includeDraft = false) {
  const docs = (await fetchContent('doc', includeDraft))
    .filter((doc) => doc.section === sectionKey)
  const sectionRecords = await fetchCourseSections()
  return applySectionOrder(docs, sectionRecords).sort(compareDocs)
}

export async function getDocSections() {
  const docs = await fetchContent('doc', false)
  const sectionRecords = await fetchCourseSections()
  const sectionMap = new Map(sectionRecords.map((section) => [section.key, section]))
  const sections = new Map()

  for (const doc of applySectionOrder(docs, sectionRecords).sort(compareDocs)) {
    const key = doc.section || slugifyText(doc.section_label || 'uncategorized')
    if (!sections.has(key)) {
      sections.set(key, {
        key,
        label: doc.section_label || 'Uncategorized',
        count: 0,
        firstDoc: doc,
        sortOrder: sectionMap.get(key)?.sort_order ?? null
      })
    }

    const section = sections.get(key)
    section.count += 1
    if (compareDocs(doc, section.firstDoc) < 0) {
      section.firstDoc = doc
    }
  }

  return [...sections.values()]
    .sort((left, right) =>
      compareSectionRecords(
        { key: left.key, label: left.label, sort_order: left.sortOrder },
        { key: right.key, label: right.label, sort_order: right.sortOrder }
      )
    )
    .map((section) => ({
      ...section,
      href: section.firstDoc ? buildDocUrl(section.firstDoc) : '/docs'
    }))
}

export async function getDocsTree(sectionKey = null) {
  const docs = sectionKey ? await getSectionDocs(sectionKey, false) : (await fetchContent('doc', false)).sort(compareDocs)
  const root = []

  for (const doc of docs) {
    const path = doc.navPath.length ? doc.navPath : [doc.section_label || 'Uncategorized', doc.title]
    const effectivePath = sectionKey ? path.slice(1) : path
    const safePath = effectivePath.length ? effectivePath : [doc.title]
    let cursor = root

    safePath.forEach((segment, index) => {
      const node = upsertNode(cursor, segment, `${doc.slug}:${index}`)
      if (index === safePath.length - 1) {
        node.item = doc
      }
      cursor = node.children
    })
  }

  return root
}

export async function getDocsIndexData() {
  const docs = await fetchContent('doc', false)
  const sections = await getDocSections()

  return {
    count: docs.length,
    sections,
    recent: [...docs]
      .sort((left, right) => compareDatesDesc(left.updated_at, right.updated_at))
      .slice(0, 8)
  }
}

export async function getHomepageSnapshot() {
  const docs = await fetchContent('doc', false)
  const sections = await getDocSections()

  return {
    blogCount: 0,
    recentBlogs: [],
    docCount: docs.length,
    sections,
    recentDocs: [...docs]
      .sort((left, right) => compareDatesDesc(left.updated_at, right.updated_at))
      .slice(0, 6)
  }
}

export async function getDocPageData(slug) {
  const doc = await getContentBySlug('doc', slug)
  if (!doc) return null

  const sections = await getDocSections()
  const currentSection = sections.find((section) => section.key === doc.section) || null
  const sectionDocs = await getSectionDocs(doc.section, false)
  const sectionTree = await getDocsTree(doc.section)
  const currentIndex = sectionDocs.findIndex((item) => item.slug === doc.slug)

  return {
    doc,
    sections,
    currentSection,
    sectionTree,
    previousDoc: currentIndex > 0 ? sectionDocs[currentIndex - 1] : null,
    nextDoc: currentIndex >= 0 && currentIndex < sectionDocs.length - 1 ? sectionDocs[currentIndex + 1] : null
  }
}

export async function getNavigationState(pathname) {
  const normalizedPath = normalizePathname(pathname)
  const sections = await getDocSections()
  const docs = await fetchContent('doc', false)
  const activeDoc = docs.find((doc) => normalizedPath === buildDocUrl(doc)) || null
  const activeSection =
    (activeDoc ? sections.find((section) => section.key === activeDoc.section) : null) ||
    sections.find((section) => normalizedPath === section.href) ||
    null

  return {
    pathname: normalizedPath,
    sections,
    activeSection
  }
}

export async function saveContent(input, actor) {
  const normalizedActor = normalizeActor(actor)
  const current = input.id ? await getContentById(input.id, actor) : null
  if (input.id && !current) {
    throw new Error('No permission to edit this document.')
  }

  const ownerUserId = normalizedActor?.userId ?? null
  const serialized = serializeContentInput(input, current)
  if (!current && ownerUserId !== null) {
    serialized.created_by_user_id = ownerUserId
  }

  if (!serialized.title) {
    throw new Error('Title is required.')
  }

  if (!serialized.slug) {
    throw new Error('Slug is required.')
  }

  if (serialized.type === 'doc' && !serialized.section_label) {
    throw new Error('Course name is required.')
  }

  if (serialized.type === 'doc') {
    serialized.section = await resolveCourseSectionKey(serialized.section_label, input.section, current)
    await ensureCourseSection(serialized.section, serialized.section_label)
  }

  const duplicate = input.id
    ? await dbGet('SELECT id FROM content_items WHERE slug = ? AND id != ?', [serialized.slug, input.id])
    : await dbGet('SELECT id FROM content_items WHERE slug = ?', [serialized.slug])

  if (duplicate) {
    throw new Error('This slug already exists.')
  }

  if (current) {
    await dbRun(
      `UPDATE content_items
       SET type = ?,
           title = ?,
           slug = ?,
           subtitle = ?,
           summary = ?,
           content = ?,
           status = ?,
           tags = ?,
           hero_image = ?,
           source_path = ?,
           section = ?,
           section_label = ?,
           nav_path = ?,
           nav_order = ?,
           nav_sequence = ?,
           created_by_user_id = ?,
           updated_at = ?,
           published_at = ?,
           is_imported = ?
       WHERE id = ?`,
      [
        serialized.type,
        serialized.title,
        serialized.slug,
        serialized.subtitle,
        serialized.summary,
        serialized.content,
        serialized.status,
        serialized.tags,
        serialized.hero_image,
        serialized.source_path,
        serialized.section,
        serialized.section_label,
        serialized.nav_path,
        serialized.nav_order,
        serialized.nav_sequence,
        serialized.created_by_user_id,
        serialized.updated_at,
        serialized.published_at,
        serialized.is_imported,
        serialized.id
      ]
    )

    const saved = await getContentById(current.id)
    return syncContentMediaLinks(saved)
  }

  const inserted = await dbGet(
    `INSERT INTO content_items (
       type,
       title,
       slug,
       subtitle,
       summary,
       content,
       status,
       tags,
       hero_image,
       source_path,
       section,
       section_label,
       nav_path,
       nav_order,
       nav_sequence,
       created_by_user_id,
       created_at,
       updated_at,
       published_at,
       is_imported
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    [
      serialized.type,
      serialized.title,
      serialized.slug,
      serialized.subtitle,
      serialized.summary,
      serialized.content,
      serialized.status,
      serialized.tags,
      serialized.hero_image,
      serialized.source_path,
      serialized.section,
      serialized.section_label,
      serialized.nav_path,
      serialized.nav_order,
      serialized.nav_sequence,
      serialized.created_by_user_id,
      serialized.created_at,
      serialized.updated_at,
      serialized.published_at,
      serialized.is_imported
    ]
  )

  const created = await getContentById(inserted.id)
  return syncContentMediaLinks(created)
}

export async function deleteImportedDocs() {
  await dbRun(`DELETE FROM content_items WHERE type = 'doc' AND is_imported = ?`, [true])
}

export async function deleteContentById(id, actor) {
  const current = await getContentById(id)
  if (!current) {
    return false
  }
  if (!actorCanManageRecord(actor, current)) {
    throw new Error('No permission to delete this document.')
  }

  const mediaRows = await dbAll(
    `SELECT id, file_path
     FROM content_media
     WHERE content_id = ?`,
    [id]
  )

  for (const row of mediaRows) {
    const mediaPath = String(row.file_path || '')
    const otherRefs = await dbGet(
      `SELECT COUNT(*) AS count
       FROM content_media
       WHERE file_path = ? AND (content_id IS NULL OR content_id != ?)`,
      [mediaPath, id]
    )
    await dbRun(`DELETE FROM content_media WHERE id = ?`, [Number(row.id)])

    if (countRowValue(otherRefs) > 0) continue

    await dbRun(`DELETE FROM media_files WHERE file_path = ?`, [mediaPath])
  }

  const result = await dbRun('DELETE FROM content_items WHERE id = ?', [id])
  return Number(result.rowCount || 0) > 0
}

export async function reorderCourseDocs(sectionKey, itemIds, actor) {
  const docs = filterDocsByActor(await getSectionDocs(sectionKey, true), actor)
  const targetIds = itemIds.map((id) => Number(id)).filter(Number.isFinite)
  const docIds = new Set(docs.map((doc) => Number(doc.id)))
  const normalized = targetIds.filter((id) => docIds.has(id))

  for (const [index, id] of normalized.entries()) {
    await dbRun(`UPDATE content_items SET nav_sequence = ? WHERE id = ?`, [index, id])
  }
}

export async function reorderCourseSections(sectionKeys, actor) {
  const normalizedActor = normalizeActor(actor)
  if (normalizedActor && !normalizedActor.isAdmin) {
    throw new Error('Only admin can reorder courses.')
  }

  const records = await fetchCourseSections()
  const validKeys = new Set(records.map((record) => record.key))
  const normalized = sectionKeys.map((key) => String(key)).filter((key) => validKeys.has(key))

  for (const [index, key] of normalized.entries()) {
    await dbRun(`UPDATE course_sections SET sort_order = ? WHERE section_key = ?`, [index, key])
  }
}

export async function renameCourseSection(sectionKey, nextLabel, actor) {
  const normalizedActor = normalizeActor(actor)
  if (!normalizedActor?.isAdmin) {
    throw new Error('Only admin can rename courses.')
  }

  const key = String(sectionKey || '').trim()
  const label = String(nextLabel || '').trim()
  if (!key) {
    throw new Error('Course key is required.')
  }
  if (!label) {
    throw new Error('Course name cannot be empty.')
  }

  const current = await dbGet(
    `SELECT section_key, label
     FROM course_sections
     WHERE section_key = ?`,
    [key]
  )
  if (!current) {
    throw new Error('Course does not exist.')
  }

  const normalizedLabel = normalizeSectionName(label)
  const duplicated = await dbGet(
    `SELECT section_key
     FROM course_sections
     WHERE section_key != ?
       AND LOWER(TRIM(label)) = ?`,
    [key, normalizedLabel]
  )
  if (duplicated) {
    throw new Error('Course name already exists.')
  }

  const previousLabel = String(current.label || '').trim()

  await dbRun(`UPDATE course_sections SET label = ? WHERE section_key = ?`, [label, key])
  await dbRun(`UPDATE content_items SET section_label = ? WHERE section = ?`, [label, key])
  await dbRun(`UPDATE content_media SET section_label = ? WHERE section = ?`, [label, key])

  // Keep the first breadcrumb segment aligned with course label.
  const rows = await dbAll(
    `SELECT id, nav_path
     FROM content_items
     WHERE type = 'doc' AND section = ?`,
    [key]
  )

  for (const row of rows) {
    const navPath = normalizeNavPath(
      (() => {
        try {
          return JSON.parse(String(row.nav_path || '[]'))
        } catch {
          return []
        }
      })()
    )
    if (!navPath.length) continue
    if (previousLabel && navPath[0] !== previousLabel) continue
    navPath[0] = label
    await dbRun(`UPDATE content_items SET nav_path = ? WHERE id = ?`, [JSON.stringify(navPath), Number(row.id)])
  }

  return { key, label }
}

export async function hideCourseSection(sectionKey, actor) {
  const normalizedActor = normalizeActor(actor)
  if (!normalizedActor?.isAdmin) {
    throw new Error('Only admin can hide courses.')
  }

  const key = String(sectionKey || '').trim()
  if (!key) {
    throw new Error('Course key is required.')
  }

  const current = await dbGet(
    `SELECT section_key, label
     FROM course_sections
     WHERE section_key = ?`,
    [key]
  )
  if (!current) {
    throw new Error('Course does not exist.')
  }

  const result = await dbRun(
    `UPDATE content_items
     SET status = 'draft',
         published_at = NULL,
         updated_at = ?
     WHERE type = 'doc' AND section = ?`,
    [nowIso(), key]
  )

  return {
    key,
    label: String(current.label || ''),
    updatedDocs: Number(result.rowCount || 0)
  }
}

export async function showCourseSection(sectionKey, actor) {
  const normalizedActor = normalizeActor(actor)
  if (!normalizedActor?.isAdmin) {
    throw new Error('Only admin can show courses.')
  }

  const key = String(sectionKey || '').trim()
  if (!key) {
    throw new Error('Course key is required.')
  }

  const current = await dbGet(
    `SELECT section_key, label
     FROM course_sections
     WHERE section_key = ?`,
    [key]
  )
  if (!current) {
    throw new Error('Course does not exist.')
  }

  const now = nowIso()
  const result = await dbRun(
    `UPDATE content_items
     SET status = 'published',
         published_at = COALESCE(published_at, ?),
         updated_at = ?
     WHERE type = 'doc' AND section = ?`,
    [now, now, key]
  )

  return {
    key,
    label: String(current.label || ''),
    updatedDocs: Number(result.rowCount || 0)
  }
}
