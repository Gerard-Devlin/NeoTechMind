import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import postgres from 'postgres'

function loadEnvFromFileIfMissing() {
  if (process.env.DATABASE_URL) return
  const envPath = resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return

  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const [key, ...rest] = trimmed.split('=')
    if (!key || process.env[key] !== undefined) continue
    process.env[key] = rest.join('=')
  }
}

loadEnvFromFileIfMissing()

const databaseUrl = String(process.env.DATABASE_URL || '').trim()

if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
  throw new Error('DATABASE_URL must be a PostgreSQL connection string (postgres:// or postgresql://).')
}

export const dbDialect = 'postgres'

let sql = null

function nowIso() {
  return new Date().toISOString()
}

function parseJsonField(value, fallback) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  return [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))]
}

function normalizeNavPath(navPath) {
  if (!Array.isArray(navPath)) return []
  return navPath.map((segment) => String(segment).trim()).filter(Boolean)
}

function hydrateContentRow(row) {
  if (!row) return null
  return {
    ...row,
    id: Number(row.id),
    created_by_user_id:
      row.created_by_user_id === null || row.created_by_user_id === undefined
        ? null
        : Number(row.created_by_user_id),
    nav_order: Number(row.nav_order ?? 999),
    nav_sequence:
      row.nav_sequence === null || row.nav_sequence === undefined ? null : Number(row.nav_sequence),
    is_imported:
      typeof row.is_imported === 'boolean' ? row.is_imported : Boolean(Number(row.is_imported)),
    isImported:
      typeof row.is_imported === 'boolean' ? row.is_imported : Boolean(Number(row.is_imported)),
    tags: normalizeTags(parseJsonField(row.tags, [])),
    navPath: normalizeNavPath(parseJsonField(row.nav_path, []))
  }
}

async function initializePostgres() {
  sql = postgres(databaseUrl, {
    max: Number(process.env.DATABASE_POOL_MAX || 10),
    idle_timeout: 20,
    connect_timeout: 15,
    ssl:
      process.env.DATABASE_SSL === 'require'
        ? 'require'
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : undefined
  })

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS content_items (
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('blog', 'doc')),
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      subtitle TEXT,
      summary TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
      tags TEXT NOT NULL DEFAULT '[]',
      hero_image TEXT,
      source_path TEXT,
      section TEXT,
      section_label TEXT,
      nav_path TEXT NOT NULL DEFAULT '[]',
      nav_order INTEGER NOT NULL DEFAULT 999,
      nav_sequence INTEGER,
      created_by_user_id BIGINT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      published_at TEXT,
      is_imported BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE INDEX IF NOT EXISTS idx_content_items_type_status
      ON content_items(type, status);

    CREATE INDEX IF NOT EXISTS idx_content_items_published_at
      ON content_items(published_at DESC);

    CREATE INDEX IF NOT EXISTS idx_content_items_section
      ON content_items(section, nav_order);

    CREATE INDEX IF NOT EXISTS idx_content_items_nav_sequence
      ON content_items(section, nav_sequence);

    CREATE INDEX IF NOT EXISTS idx_content_items_owner
      ON content_items(created_by_user_id);

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      user_id BIGINT,
      username TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS course_sections (
      section_key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 999
    );

    CREATE INDEX IF NOT EXISTS idx_course_sections_sort_order
      ON course_sections(sort_order);

    CREATE TABLE IF NOT EXISTS content_media (
      id BIGSERIAL PRIMARY KEY,
      content_id BIGINT REFERENCES content_items(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      original_name TEXT,
      mime_type TEXT,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      section TEXT,
      section_label TEXT,
      owner_user_id BIGINT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_content_media_content_id
      ON content_media(content_id);

    CREATE INDEX IF NOT EXISTS idx_content_media_file_path
      ON content_media(file_path);

    CREATE INDEX IF NOT EXISTS idx_content_media_owner
      ON content_media(owner_user_id);

    CREATE TABLE IF NOT EXISTS media_files (
      id BIGSERIAL PRIMARY KEY,
      file_path TEXT NOT NULL UNIQUE,
      mime_type TEXT,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      blob_data BYTEA NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_media_files_file_path
      ON media_files(file_path);
  `)

  await sql.unsafe(`
    ALTER TABLE content_items
    ADD COLUMN IF NOT EXISTS subtitle TEXT;
  `)
  await sql.unsafe(`
    ALTER TABLE content_items
    ADD COLUMN IF NOT EXISTS nav_sequence INTEGER;
  `)
  await sql.unsafe(`
    ALTER TABLE content_items
    ADD COLUMN IF NOT EXISTS created_by_user_id BIGINT;
  `)
  await sql.unsafe(`
    ALTER TABLE admin_sessions
    ADD COLUMN IF NOT EXISTS user_id BIGINT;
  `)
  await sql.unsafe(`
    ALTER TABLE admin_sessions
    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'editor';
  `)
  await sql.unsafe(`
    ALTER TABLE content_media
    ADD COLUMN IF NOT EXISTS owner_user_id BIGINT;
  `)
}

function convertPlaceholders(statement) {
  let index = 0
  return statement.replace(/\?/g, () => {
    index += 1
    return `$${index}`
  })
}

export const ready = initializePostgres()

export async function dbAll(statement, params = []) {
  await ready
  return sql.unsafe(convertPlaceholders(statement), params)
}

export async function dbGet(statement, params = []) {
  await ready
  const rows = await sql.unsafe(convertPlaceholders(statement), params)
  return rows[0] || null
}

export async function dbRun(statement, params = []) {
  await ready
  const rows = await sql.unsafe(convertPlaceholders(statement), params)
  return {
    rowCount: Number(rows.count ?? rows.length ?? 0),
    rows
  }
}

export async function cleanupExpiredSessions() {
  await dbRun('DELETE FROM admin_sessions WHERE expires_at <= ?', [nowIso()])
}

export {
  hydrateContentRow,
  normalizeNavPath,
  normalizeTags,
  nowIso,
  parseJsonField
}
