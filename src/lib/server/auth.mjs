import crypto from 'node:crypto'

import { cleanupExpiredSessions, dbAll, dbGet, dbRun, nowIso } from './db.mjs'

export const ADMIN_COOKIE = 'neotechmind_session'

function getAdminConfig() {
  return {
    username: String(process.env.ADMIN_USERNAME || 'admin').trim() || 'admin',
    password: String(process.env.ADMIN_PASSWORD || 'neotechmind123')
  }
}

function normalizeRole(value) {
  return String(value || '').toLowerCase() === 'admin' ? 'admin' : 'editor'
}

export function isAdminSession(session) {
  return normalizeRole(session?.role) === 'admin'
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const safePassword = String(password || '')
  const hash = crypto.scryptSync(safePassword, salt, 64).toString('hex')
  return `scrypt:${salt}:${hash}`
}

function verifyPassword(password, encoded) {
  const safeEncoded = String(encoded || '')
  const safePassword = String(password || '')

  if (safeEncoded.startsWith('scrypt:')) {
    const [, salt, savedHash] = safeEncoded.split(':')
    if (!salt || !savedHash) return false
    const nextHash = crypto.scryptSync(safePassword, salt, 64).toString('hex')
    return crypto.timingSafeEqual(Buffer.from(nextHash), Buffer.from(savedHash))
  }

  return safePassword === safeEncoded
}

let bootstrapPromise = null

export async function ensureBootstrapAdminUser() {
  if (bootstrapPromise) return bootstrapPromise

  bootstrapPromise = (async () => {
    const admin = getAdminConfig()
    const existing = await dbGet(
      `SELECT id, username, role
       FROM admin_users
       WHERE username = ?
       LIMIT 1`,
      [admin.username]
    )

    if (existing?.id) {
      if (normalizeRole(existing.role) !== 'admin') {
        await dbRun(
          `UPDATE admin_users
           SET role = 'admin',
               updated_at = ?
           WHERE id = ?`,
          [nowIso(), Number(existing.id)]
        )
      }
      return
    }

    const now = nowIso()
    await dbRun(
      `INSERT INTO admin_users (username, password_hash, role, is_active, created_at, updated_at)
       VALUES (?, ?, 'admin', ?, ?, ?)`,
      [admin.username, hashPassword(admin.password), true, now, now]
    )
  })().finally(() => {
    bootstrapPromise = null
  })

  return bootstrapPromise
}

export async function verifyAdminCredentials(username, password) {
  await ensureBootstrapAdminUser()
  const safeUsername = String(username || '').trim()
  const user = await dbGet(
    `SELECT id, username, password_hash, role, is_active
     FROM admin_users
     WHERE username = ?
     LIMIT 1`,
    [safeUsername]
  )

  if (!user?.id || !Boolean(user.is_active)) return null
  if (!verifyPassword(password, user.password_hash)) return null

  return {
    userId: Number(user.id),
    username: String(user.username),
    role: normalizeRole(user.role)
  }
}

export async function createAdminSession(user) {
  await ensureBootstrapAdminUser()
  await cleanupExpiredSessions()

  const userId = Number(user?.userId || user?.id)
  const username = String(user?.username || '').trim()
  const role = normalizeRole(user?.role)

  if (!Number.isFinite(userId) || !username) {
    throw new Error('Invalid session user')
  }

  const token = crypto.randomUUID()
  const createdAt = nowIso()
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

  await dbRun(
    `INSERT INTO admin_sessions (token, user_id, username, role, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [token, userId, username, role, createdAt, expiresAt]
  )

  return { token, userId, username, role, createdAt, expiresAt }
}

export async function getSessionByToken(token) {
  if (!token) return null
  await ensureBootstrapAdminUser()
  await cleanupExpiredSessions()

  const row = await dbGet(
    `SELECT
       s.token,
       s.user_id,
       s.username AS session_username,
       s.role AS session_role,
       s.created_at,
       s.expires_at,
       u.username AS user_username,
       u.role AS user_role,
       u.is_active
     FROM admin_sessions s
     LEFT JOIN admin_users u
       ON u.id = s.user_id
       OR (s.user_id IS NULL AND u.username = s.username)
     WHERE s.token = ?
     LIMIT 1`,
    [token]
  )

  if (!row) return null
  if (row.expires_at <= nowIso()) {
    await dbRun('DELETE FROM admin_sessions WHERE token = ?', [token])
    return null
  }

  if (row.user_id && !Boolean(row.is_active)) {
    await dbRun('DELETE FROM admin_sessions WHERE token = ?', [token])
    return null
  }

  return {
    token: String(row.token),
    userId: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
    username: String(row.user_username || row.session_username || ''),
    role: normalizeRole(row.user_role || row.session_role || 'editor'),
    created_at: String(row.created_at),
    expires_at: String(row.expires_at)
  }
}

export async function destroySession(token) {
  if (!token) return
  await dbRun('DELETE FROM admin_sessions WHERE token = ?', [token])
}

export async function getSessionFromCookies(cookies) {
  const token = cookies.get(ADMIN_COOKIE)?.value
  return getSessionByToken(token)
}

export function setSessionCookie(cookies, token, expiresAt) {
  cookies.set(ADMIN_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    expires: new Date(expiresAt)
  })
}

export function clearSessionCookie(cookies) {
  cookies.delete(ADMIN_COOKIE, { path: '/' })
}

export async function listAdminUsers() {
  await ensureBootstrapAdminUser()
  const rows = await dbAll(
    `SELECT id, username, role, is_active, created_at, updated_at
     FROM admin_users
     ORDER BY id ASC`
  )
  return rows.map((row) => ({
    id: Number(row.id),
    username: String(row.username),
    role: normalizeRole(row.role),
    is_active: Boolean(row.is_active),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || '')
  }))
}

export async function createAdminUser(input) {
  await ensureBootstrapAdminUser()
  const username = String(input?.username || '').trim()
  const password = String(input?.password || '')
  const role = normalizeRole(input?.role)

  if (!username) throw new Error('用户名不能为空。')
  if (password.length < 6) throw new Error('密码至少 6 位。')

  const duplicate = await dbGet(
    `SELECT id
     FROM admin_users
     WHERE username = ?
     LIMIT 1`,
    [username]
  )
  if (duplicate?.id) {
    throw new Error('用户名已存在。')
  }

  const now = nowIso()
  await dbRun(
    `INSERT INTO admin_users (username, password_hash, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [username, hashPassword(password), role, true, now, now]
  )
}

async function getAdminUserById(userId) {
  const safeId = Number(userId)
  if (!Number.isFinite(safeId)) return null
  const row = await dbGet(
    `SELECT id, username, role, is_active
     FROM admin_users
     WHERE id = ?
     LIMIT 1`,
    [safeId]
  )
  if (!row?.id) return null
  return {
    id: Number(row.id),
    username: String(row.username),
    role: normalizeRole(row.role),
    is_active: Boolean(row.is_active)
  }
}

async function countActiveAdmins(excludeUserId = null) {
  const safeExcludeId = Number(excludeUserId)
  if (Number.isFinite(safeExcludeId)) {
    const row = await dbGet(
      `SELECT COUNT(*) AS count
       FROM admin_users
       WHERE role = 'admin'
         AND is_active = TRUE
         AND id <> ?`,
      [safeExcludeId]
    )
    return Number(row?.count || 0)
  }

  const row = await dbGet(
    `SELECT COUNT(*) AS count
     FROM admin_users
     WHERE role = 'admin'
       AND is_active = TRUE`
  )
  return Number(row?.count || 0)
}

export async function setAdminUserActive(input) {
  await ensureBootstrapAdminUser()
  const targetUserId = Number(input?.targetUserId)
  const actorUserId = Number(input?.actorUserId)
  const active = Boolean(input?.active)

  if (!Number.isFinite(targetUserId)) throw new Error('无效的用户。')

  const target = await getAdminUserById(targetUserId)
  if (!target) throw new Error('用户不存在。')

  if (!active && Number.isFinite(actorUserId) && target.id === actorUserId) {
    throw new Error('不能封禁当前登录账号。')
  }

  if (!active && target.role === 'admin') {
    const remainingAdmins = await countActiveAdmins(target.id)
    if (remainingAdmins <= 0) {
      throw new Error('至少保留一个启用状态的管理员。')
    }
  }

  await dbRun(
    `UPDATE admin_users
     SET is_active = ?,
         updated_at = ?
     WHERE id = ?`,
    [active, nowIso(), target.id]
  )

  if (!active) {
    await dbRun('DELETE FROM admin_sessions WHERE user_id = ?', [target.id])
  }
}

export async function updateAdminUserRole(input) {
  await ensureBootstrapAdminUser()
  const targetUserId = Number(input?.targetUserId)
  const actorUserId = Number(input?.actorUserId)
  const nextRole = normalizeRole(input?.role)

  if (!Number.isFinite(targetUserId)) throw new Error('无效的用户。')
  const target = await getAdminUserById(targetUserId)
  if (!target) throw new Error('用户不存在。')
  if (target.role === nextRole) return

  if (
    target.role === 'admin' &&
    nextRole !== 'admin' &&
    target.is_active
  ) {
    if (Number.isFinite(actorUserId) && target.id === actorUserId) {
      throw new Error('不能将当前登录管理员降级。')
    }
    const remainingAdmins = await countActiveAdmins(target.id)
    if (remainingAdmins <= 0) {
      throw new Error('至少保留一个启用状态的管理员。')
    }
  }

  await dbRun(
    `UPDATE admin_users
     SET role = ?,
         updated_at = ?
     WHERE id = ?`,
    [nextRole, nowIso(), target.id]
  )
}

export async function deleteAdminUser(input) {
  await ensureBootstrapAdminUser()
  const targetUserId = Number(input?.targetUserId)
  const actorUserId = Number(input?.actorUserId)

  if (!Number.isFinite(targetUserId)) throw new Error('无效的用户。')
  const target = await getAdminUserById(targetUserId)
  if (!target) throw new Error('用户不存在。')

  if (Number.isFinite(actorUserId) && target.id === actorUserId) {
    throw new Error('不能删除当前登录账号。')
  }

  if (target.role === 'admin' && target.is_active) {
    const remainingAdmins = await countActiveAdmins(target.id)
    if (remainingAdmins <= 0) {
      throw new Error('至少保留一个启用状态的管理员。')
    }
  }

  await dbRun('DELETE FROM admin_sessions WHERE user_id = ?', [target.id])
  await dbRun('DELETE FROM admin_users WHERE id = ?', [target.id])
}
