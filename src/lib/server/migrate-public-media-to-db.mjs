import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function loadEnv() {
  if (process.env.DATABASE_URL) return
  const envFile = resolve(process.cwd(), '.env')
  if (!existsSync(envFile)) return

  const lines = readFileSync(envFile, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const [key, ...rest] = trimmed.split('=')
    if (!key || process.env[key] !== undefined) continue
    process.env[key] = rest.join('=')
  }
}

function normalizeMediaPath(value) {
  const raw = String(value || '').trim()
  let clean = raw.split('#')[0].split('?')[0]
  while (/[),.;]$/.test(clean)) {
    clean = clean.slice(0, -1)
  }
  if (!clean) return ''
  if (clean.startsWith('/uploads/') || clean.startsWith('/imports/techmind/')) {
    return clean
  }
  return ''
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

loadEnv()

const { dbAll, dbGet } = await import('./db.mjs')
const { storeMediaBlob } = await import('./content.mjs')

const referenced = new Set()

const contentRows = await dbAll(
  `SELECT content, hero_image
   FROM content_items`
)
for (const row of contentRows) {
  for (const path of extractMediaPaths(row.content, row.hero_image)) {
    referenced.add(path)
  }
}

const mediaRows = await dbAll(
  `SELECT file_path
   FROM content_media`
)
for (const row of mediaRows) {
  const normalized = normalizeMediaPath(row.file_path)
  if (normalized) referenced.add(normalized)
}

let imported = 0
const missingOnDisk = []

for (const filePath of referenced) {
  const existing = await dbGet(
    `SELECT id
     FROM media_files
     WHERE file_path = ?
     LIMIT 1`,
    [filePath]
  )
  if (existing?.id) continue

  const fsPath = resolve(process.cwd(), 'public', filePath.slice(1))
  if (!existsSync(fsPath)) {
    missingOnDisk.push(filePath)
    continue
  }

  const payload = readFileSync(fsPath)
  const stored = await storeMediaBlob({
    filePath,
    blobData: payload
  })
  if (stored?.id) {
    imported += 1
  }
}

console.log(`Media DB migration completed: imported ${imported} missing ${missingOnDisk.length}`)
if (missingOnDisk.length > 0) {
  console.log('Missing paths:')
  for (const path of missingOnDisk.slice(0, 50)) {
    console.log(`- ${path}`)
  }
  if (missingOnDisk.length > 50) {
    console.log(`... and ${missingOnDisk.length - 50} more`)
  }
}
