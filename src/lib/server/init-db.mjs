import { dbDialect, ready } from './db.mjs'

await ready
console.log(`NeoTechMind database ready (${dbDialect})`)
