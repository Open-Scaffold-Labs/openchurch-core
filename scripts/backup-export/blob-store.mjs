// Two interchangeable stores with the same four calls:
//   list(prefix) -> [{ pathname, size, uploadedAt }]
//   putFile(pathname, localPath, contentType)
//   getToFile(pathname, localPath)
//   del(pathnames)
//
// "vercel"  the real private Vercel Blob store (@vercel/blob, pinned in
//           scripts/backup-export/package.json). Auth: BLOB_READ_WRITE_TOKEN.
//           Every call passes access:'private'; a public store is refused
//           by the SDK/API rather than silently publishing a dump.
// "stub"    a local directory (OC_BACKUP_BLOB_STUB_DIR) used only by the
//           end-to-end test. Refused under GitHub Actions (lib.checkExportEnv).

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rm, stat, copyFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export async function openStore(env = process.env) {
  if (env.OC_BACKUP_BLOB_STUB_DIR) return stubStore(env.OC_BACKUP_BLOB_STUB_DIR)
  if (!env.BLOB_READ_WRITE_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN is not set')
  let sdk
  try { sdk = await import('@vercel/blob') } catch {
    throw new Error('@vercel/blob is not installed. Run: npm ci --prefix scripts/backup-export')
  }
  return vercelStore(sdk, env.BLOB_READ_WRITE_TOKEN)
}

function safeJoin(root, pathname) {
  if (pathname.includes('..') || pathname.startsWith('/')) throw new Error(`bad pathname ${pathname}`)
  return join(root, ...pathname.split('/'))
}

export function stubStore(root) {
  return {
    kind: 'stub',
    async list(prefix) {
      const out = []
      const walk = async dir => {
        let ents = []
        try { ents = await readdir(dir, { withFileTypes: true }) } catch (e) { if (e.code === 'ENOENT') return; throw e }
        for (const e of ents) {
          const p = join(dir, e.name)
          if (e.isDirectory()) await walk(p)
          else {
            const pathname = relative(root, p).split(sep).join('/')
            if (pathname.startsWith(prefix)) { const s = await stat(p); out.push({ pathname, size: s.size, uploadedAt: s.mtime }) }
          }
        }
      }
      await walk(root)
      return out
    },
    async putFile(pathname, localPath) {
      const dest = safeJoin(root, pathname)
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(localPath, dest, 1 /* COPYFILE_EXCL: no overwrite, like the real store */)
    },
    async getToFile(pathname, localPath) { await copyFile(safeJoin(root, pathname), localPath) },
    async del(pathnames) { for (const p of pathnames) await rm(safeJoin(root, p), { force: true }) },
  }
}

export function vercelStore(sdk, token) {
  const base = { token, access: 'private' }
  return {
    kind: 'vercel',
    async list(prefix) {
      const out = []
      let cursor
      do {
        const r = await sdk.list({ token, prefix, cursor, limit: 1000 })
        out.push(...r.blobs.map(b => ({ pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt })))
        cursor = r.hasMore ? r.cursor : undefined
      } while (cursor)
      return out
    },
    async putFile(pathname, localPath, contentType = 'application/octet-stream') {
      const s = await stat(localPath)
      const r = await sdk.put(pathname, createReadStream(localPath), {
        ...base, contentType, addRandomSuffix: false, allowOverwrite: false, multipart: s.size > 8 * 1024 * 1024,
      })
      if (!r || r.pathname !== pathname) throw new Error(`upload of ${pathname} returned an unexpected result`)
      if (/\.public\.blob\./.test(r.url || '')) throw new Error('Blob store is PUBLIC. Refusing: backups require a private store')
    },
    async getToFile(pathname, localPath) {
      const r = await sdk.get(pathname, { ...base, useCache: false })
      if (!r || r.statusCode !== 200 || !r.stream) throw new Error(`download of ${pathname} failed`)
      await pipeline(Readable.fromWeb(r.stream), createWriteStream(localPath))
    },
    async del(pathnames) { if (pathnames.length) await sdk.del(pathnames, { token }) },
  }
}
