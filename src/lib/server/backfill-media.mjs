import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

if (!process.env.DATABASE_URL) {
  const envFile = resolve(process.cwd(), '.env')
  if (existsSync(envFile)) {
    const lines = readFileSync(envFile, 'utf8').split(/\r?\n/)
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
      const [key, ...rest] = trimmed.split('=')
      if (!key || process.env[key] !== undefined) continue
      process.env[key] = rest.join('=')
    }
  }
}

const { backfillMediaFilesFromContent } = await import('./content.mjs')
const result = await backfillMediaFilesFromContent()
console.log(`Media backfill completed: ${result.synced}/${result.total}`)
