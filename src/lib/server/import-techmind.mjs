import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'

import yaml from 'js-yaml'

import { deleteImportedDocs, saveContent, slugifyPathSegments, storeMediaBlob } from './content.mjs'

const explicitSource = process.argv[2] || process.env.TECHMIND_PATH || ''
if (!explicitSource) {
  throw new Error(
    'TechMind source path is required. Pass it as `npm run import:techmind -- "D:/path/to/docs"` or set TECHMIND_PATH temporarily.'
  )
}

const sourceRoot = resolve(explicitSource)
const projectRoot = resolve(sourceRoot, '..')
const mkdocsFile = join(projectRoot, 'mkdocs.yml')
const ignoredTopLevel = new Set(['assets', 'javascripts', 'stylesheets'])

function walkMarkdownFiles(directory) {
  const entries = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (directory === sourceRoot && ignoredTopLevel.has(entry.name)) continue
      entries.push(...walkMarkdownFiles(fullPath))
      continue
    }
    if (entry.isFile() && ['.md', '.mdx'].includes(extname(entry.name).toLowerCase())) {
      entries.push(fullPath)
    }
  }
  return entries
}

function walkMediaFiles(directory) {
  const entries = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      entries.push(...walkMediaFiles(fullPath))
      continue
    }

    if (entry.isFile() && !['.md', '.mdx'].includes(extname(entry.name).toLowerCase())) {
      entries.push(fullPath)
    }
  }
  return entries
}

function getRelativeSourcePath(filePath) {
  return relative(sourceRoot, filePath).replaceAll('\\', '/')
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) {
    return { data: {}, body: content }
  }
  const rawYaml = match[1]
  const body = content.slice(match[0].length)

  try {
    return {
      data: yaml.load(rawYaml) || {},
      body
    }
  } catch {
    return { data: {}, body: content }
  }
}

function extractTitle(content, fallback) {
  const h1Match = content.match(/<h1>\s*([\s\S]*?)\s*<\/h1>/i)
  if (h1Match?.[1]) {
    return h1Match[1].replace(/<[^>]+>/g, '').trim()
  }
  const markdownHeading = content.match(/^#\s+(.+)$/m)
  if (markdownHeading?.[1]) {
    return markdownHeading[1].trim()
  }
  return fallback
}

function removeLeadingHtmlHeading(content) {
  return content.replace(/^\s*<h1>\s*[\s\S]*?\s*<\/h1>\s*/i, '')
}

function parseOrder(value) {
  const match = String(value || '').match(/^(\d+(?:\.\d+)*)/)
  if (!match?.[1]) return 999
  return Number(match[1])
}

function pathSegmentsForNav(relativePath) {
  const parts = relativePath.split('/')
  const filename = parts.pop() || ''
  const stem = filename.replace(/\.(md|mdx)$/i, '')
  if (stem.toLowerCase() !== 'index') {
    parts.push(stem)
  }
  return parts
}

function buildSlug(relativePath) {
  return slugifyPathSegments(pathSegmentsForNav(relativePath))
}

function sanitizeMkdocsYaml(rawContent) {
  return rawContent.replace(/!!python\/name:[^\s]+/g, "'python-object'")
}

function normalizeNavFilePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '')
}

function buildMkdocsNavMap() {
  if (!existsSync(mkdocsFile)) {
    return new Map()
  }

  const raw = readFileSync(mkdocsFile, 'utf8')
  const parsed = yaml.load(sanitizeMkdocsYaml(raw)) || {}
  const navigation = Array.isArray(parsed.nav) ? parsed.nav : []
  const navMap = new Map()
  const state = { sequence: 0 }

  function walk(items, parents = []) {
    if (!Array.isArray(items)) return

    for (const item of items) {
      if (typeof item === 'string') {
        navMap.set(normalizeNavFilePath(item), {
          navPath: [...parents],
          navOrder: parseOrder(parents.at(-1) || ''),
          navSequence: state.sequence
        })
        state.sequence += 1
        continue
      }

      if (!item || typeof item !== 'object' || Array.isArray(item)) continue

      for (const [label, value] of Object.entries(item)) {
        if (Array.isArray(value)) {
          walk(value, [...parents, label])
          continue
        }

        if (typeof value === 'string') {
          navMap.set(normalizeNavFilePath(value), {
            navPath: [...parents, label],
            navOrder: parseOrder(label),
            navSequence: state.sequence
          })
          state.sequence += 1
        }
      }
    }
  }

  walk(navigation)
  return navMap
}

function normalizeTargetPath(currentFile, targetPath) {
  if (!targetPath || /^([a-z]+:)?\/\//i.test(targetPath) || targetPath.startsWith('mailto:')) {
    return targetPath
  }
  const [rawPath, hash = ''] = targetPath.split('#')
  if (!rawPath) return targetPath

  const resolved = resolve(dirname(currentFile), decodeURIComponent(rawPath))
  const hashSuffix = hash ? `#${hash}` : ''

  if (fileMetaByAbsolutePath.has(resolved)) {
    return `/docs/${fileMetaByAbsolutePath.get(resolved).slug}${hashSuffix}`
  }
  if (fileMetaByAbsolutePath.has(`${resolved}.md`)) {
    return `/docs/${fileMetaByAbsolutePath.get(`${resolved}.md`).slug}${hashSuffix}`
  }
  if (fileMetaByAbsolutePath.has(`${resolved}.mdx`)) {
    return `/docs/${fileMetaByAbsolutePath.get(`${resolved}.mdx`).slug}${hashSuffix}`
  }
  if (fileMetaByAbsolutePath.has(join(resolved, 'index.md'))) {
    return `/docs/${fileMetaByAbsolutePath.get(join(resolved, 'index.md')).slug}${hashSuffix}`
  }

  const relativeFromDocs = relative(sourceRoot, resolved).replaceAll('\\', '/')
  if (!relativeFromDocs.startsWith('..')) {
    return `/imports/techmind/${relativeFromDocs}${hashSuffix}`
  }

  return targetPath
}

function rewriteMarkdownLinks(content, currentFile) {
  const markdownLinks = /(!?\[[^\]]*])\(([^)]+)\)/g
  const htmlImageLinks = /(<img\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi
  const htmlAnchorLinks = /(<a\b[^>]*\bhref=["'])([^"']+)(["'][^>]*>)/gi

  return content
    .replace(markdownLinks, (full, label, rawTarget) => {
      const parts = rawTarget.match(/^(.*?)(\s+"[^"]*")?$/)
      if (!parts) return full
      const nextTarget = normalizeTargetPath(currentFile, parts[1])
      return `${label}(${nextTarget}${parts[2] || ''})`
    })
    .replace(htmlImageLinks, (_match, before, rawTarget, after) => {
      return `${before}${normalizeTargetPath(currentFile, rawTarget)}${after}`
    })
    .replace(htmlAnchorLinks, (_match, before, rawTarget, after) => {
      return `${before}${normalizeTargetPath(currentFile, rawTarget)}${after}`
    })
}

const markdownFiles = walkMarkdownFiles(sourceRoot)
const mkdocsNavMap = buildMkdocsNavMap()
const fileMetaByAbsolutePath = new Map()

for (const filePath of markdownFiles) {
  const relativePath = getRelativeSourcePath(filePath)
  if (relativePath === 'index.md') continue

  const filename = relativePath.split('/').at(-1)?.replace(/\.(md|mdx)$/i, '') || 'untitled'
  const rawFile = readFileSync(filePath, 'utf8')
  const { data: frontmatter, body } = parseFrontmatter(rawFile)
  const mkdocsMeta = mkdocsNavMap.get(relativePath)
  const fallbackTitle = mkdocsMeta?.navPath?.at(-1) || filename
  const title = String(frontmatter.title || '').trim() || fallbackTitle || extractTitle(body, filename)
  const navPath = mkdocsMeta?.navPath || pathSegmentsForNav(relativePath)
  const sectionLabel = navPath[0] || 'Uncategorized'

  fileMetaByAbsolutePath.set(filePath, {
    relativePath,
    title,
    subtitle: String(frontmatter.subtitle || '').trim() || null,
    slug: buildSlug(relativePath),
    navPath,
    sectionLabel,
    navOrder: mkdocsMeta?.navOrder ?? parseOrder(navPath.at(-1) || filename),
    navSequence: mkdocsMeta?.navSequence ?? null
  })
}

await deleteImportedDocs()

let importedCount = 0
let importedMediaCount = 0

const sortedEntries = [...fileMetaByAbsolutePath.entries()].sort((left, right) => {
  const leftSequence = Number(left[1].navSequence ?? Number.MAX_SAFE_INTEGER)
  const rightSequence = Number(right[1].navSequence ?? Number.MAX_SAFE_INTEGER)
  if (leftSequence !== rightSequence) return leftSequence - rightSequence
  return left[1].relativePath.localeCompare(right[1].relativePath, 'zh-CN')
})

for (const [filePath, meta] of sortedEntries) {
  const rawFile = readFileSync(filePath, 'utf8')
  const { body } = parseFrontmatter(rawFile)
  let content = body
  content = removeLeadingHtmlHeading(content)
  content = rewriteMarkdownLinks(content, filePath)

  const stat = statSync(filePath)

  await saveContent({
    type: 'doc',
    title: meta.title,
    subtitle: meta.subtitle,
    slug: meta.slug,
    summary: '',
    content,
    status: 'published',
    tags: [],
    sectionLabel: meta.sectionLabel,
    navPath: meta.navPath,
    navOrder: meta.navOrder,
    navSequence: meta.navSequence,
    sourcePath: meta.relativePath,
    publishedAt: stat.mtime.toISOString(),
    isImported: true
  })

  importedCount += 1
}

const mediaFiles = walkMediaFiles(sourceRoot)
for (const mediaPath of mediaFiles) {
  const relativePath = getRelativeSourcePath(mediaPath)
  if (!relativePath || relativePath.startsWith('..')) continue

  const payload = readFileSync(mediaPath)

  const stored = await storeMediaBlob({
    filePath: `/imports/techmind/${relativePath}`,
    mimeType: null,
    blobData: payload
  })

  if (stored?.id) {
    importedMediaCount += 1
  }
}

console.log(
  `TechMind import completed: ${importedCount} docs + ${importedMediaCount}/${mediaFiles.length} media files imported from ${sourceRoot}`
)
