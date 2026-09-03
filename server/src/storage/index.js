// Somewhere for a backup to actually go.
//
// The weekly digest used to deliver by email and nothing else. With no
// email transport configured that meant it built an export of every
// parish, printed it to a log, and reported success — the artifact
// existed for the length of one function call. Email was never the right
// vault anyway: an 8 MB attachment cap, and one 21,100-record parish is
// already 286 KiB gzipped.
//
// THE SEAM, NOT THE VENDOR. Same shape as email, billing, monitoring and
// notification transport: one interface, drivers chosen by environment,
// and a default that reports itself absent rather than pretending. The
// team lead picks the provider; nothing in this file or above it changes
// when they do.
//
//   BACKUP_STORAGE=s3     any S3-compatible service — AWS, Cloudflare R2,
//                         Backblaze B2, Supabase Storage, MinIO. Needs
//                         BACKUP_S3_BUCKET, BACKUP_S3_REGION,
//                         BACKUP_S3_KEY_ID, BACKUP_S3_SECRET, and
//                         BACKUP_S3_ENDPOINT for anything but AWS.
//
//   BACKUP_STORAGE=file   a directory on disk. For a long-lived server or
//                         a self-hosted deployment. NOT for Vercel, whose
//                         filesystem does not survive the request — the
//                         driver says so rather than appearing to work.
//
//   unset                 absent. Callers ask before they build.
//
// NO SDK. Signing is ~120 lines in ./sigv4.js, proved against Amazon's
// own published test vectors. @aws-sdk/client-s3 is tens of megabytes
// and puts one vendor's client surface into a project whose convention
// is vendor-neutral plumbing.

import { writeFile, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { signRequest } from './sigv4.js'
import { monitor } from '../monitoring/index.js'

const env = k => process.env[k] || ''

function s3Config() {
  const bucket = env('BACKUP_S3_BUCKET')
  const keyId = env('BACKUP_S3_KEY_ID')
  const secret = env('BACKUP_S3_SECRET')
  if (!bucket || !keyId || !secret) return null
  const endpoint = env('BACKUP_S3_ENDPOINT')
  return {
    bucket, keyId, secret, endpoint,
    region: env('BACKUP_S3_REGION') || 'auto',
    // Virtual-host style (bucket.s3.amazonaws.com) is AWS's default;
    // almost everything else — R2, B2, Supabase, MinIO — wants the
    // bucket in the path. Default follows whether a custom endpoint was
    // given, which is right in both cases, and can be forced either way.
    pathStyle: env('BACKUP_S3_FORCE_PATH_STYLE')
      ? env('BACKUP_S3_FORCE_PATH_STYLE') !== 'false'
      : Boolean(endpoint),
  }
}

export function describeStorage() {
  const declared = env('BACKUP_STORAGE')
  const s3 = s3Config()

  if (declared === 'file' || (!declared && env('BACKUP_DIR'))) {
    const dir = env('BACKUP_DIR')
    if (!dir) return { driver: 'file', live: false, detail: 'BACKUP_DIR is not set' }
    // A serverless function's filesystem is per-invocation. Writing a
    // backup there is indistinguishable from writing it to /dev/null,
    // except that it looks like it worked.
    if (env('VERCEL')) {
      return { driver: 'file', live: false, detail: 'the file driver cannot be used on Vercel — its filesystem does not outlive the request' }
    }
    return { driver: 'file', live: true, detail: dir }
  }

  if (declared === 's3' || (!declared && s3)) {
    if (!s3) return { driver: 's3', live: false, detail: 'BACKUP_S3_BUCKET, BACKUP_S3_KEY_ID and BACKUP_S3_SECRET are all required' }
    return {
      driver: 's3', live: true,
      detail: `${s3.bucket}${s3.endpoint ? ` at ${s3.endpoint}` : ' on AWS'} (${s3.region})`,
    }
  }

  return { driver: 'none', live: false, detail: 'no backup storage configured' }
}

export function storageIsLive() { return describeStorage().live }

// ── s3 ───────────────────────────────────────────────────────────────────

function s3Url(cfg, key) {
  const base = cfg.endpoint || `https://s3.${cfg.region}.amazonaws.com`
  const u = new URL(base)
  const path = cfg.pathStyle ? `/${cfg.bucket}/${key}` : `/${key}`
  if (!cfg.pathStyle) u.hostname = `${cfg.bucket}.${u.hostname}`
  return { url: `${u.origin}${path}`, host: u.host, path }
}

async function s3Request({ method, key, body = Buffer.alloc(0), contentType, query }) {
  const cfg = s3Config()
  const { url, host, path } = s3Url(cfg, key)
  const headers = signRequest({
    method, host, path, query,
    headers: contentType ? { 'content-type': contentType } : {},
    payload: body,
    accessKeyId: cfg.keyId, secretAccessKey: cfg.secret,
    region: cfg.region, service: 's3',
  })
  delete headers._debug

  const qs = query
    ? '?' + Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : ''
  const res = await fetch(url + qs, {
    method, headers,
    body: method === 'PUT' ? body : undefined,
  })
  if (!res.ok) {
    // The service's own XML message is far more useful than a status
    // code — "SignatureDoesNotMatch" and "NoSuchBucket" are different
    // afternoons.
    const detail = (await res.text().catch(() => '')).slice(0, 400)
    throw new Error(`S3 ${method} ${key} → ${res.status} ${detail}`)
  }
  return res
}

// ── the interface ────────────────────────────────────────────────────────

export async function putObject({ key, body, contentType = 'application/octet-stream' }) {
  const s = describeStorage()
  if (!s.live) throw new Error(`storage not available: ${s.detail}`)
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)

  if (s.driver === 'file') {
    const path = join(env('BACKUP_DIR'), key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, buf)
    return { key, bytes: buf.length, where: path }
  }

  await s3Request({ method: 'PUT', key, body: buf, contentType })
  return { key, bytes: buf.length, where: `${s3Config().bucket}/${key}` }
}

export async function getObject(key) {
  const s = describeStorage()
  if (!s.live) throw new Error(`storage not available: ${s.detail}`)
  if (s.driver === 'file') return readFile(join(env('BACKUP_DIR'), key))
  const res = await s3Request({ method: 'GET', key })
  return Buffer.from(await res.arrayBuffer())
}

// Enough to answer "is anything actually in there, and how old is the
// newest one" — which is the question a recovery drill asks and the one
// nobody could answer before this existed.
export async function listObjects(prefix = '') {
  const s = describeStorage()
  if (!s.live) throw new Error(`storage not available: ${s.detail}`)

  if (s.driver === 'file') {
    const root = env('BACKUP_DIR')
    const out = []
    const walk = async rel => {
      let entries = []
      try { entries = await readdir(join(root, rel), { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) { await walk(r); continue }
        if (!r.startsWith(prefix)) continue
        const st = await stat(join(root, r))
        out.push({ key: r, bytes: st.size, modified: st.mtime.toISOString() })
      }
    }
    await walk('')
    return out.sort((a, b) => (a.key < b.key ? 1 : -1))
  }

  const res = await s3Request({ method: 'GET', key: '', query: { 'list-type': '2', prefix } })
  const xml = await res.text()
  // A deliberately small parser rather than an XML dependency: ListObjectsV2
  // returns a flat, predictable shape and we need three fields from it.
  const out = []
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const pick = tag => (m[1].match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [, ''])[1]
    out.push({ key: pick('Key'), bytes: Number(pick('Size')) || 0, modified: pick('LastModified') })
  }
  return out.sort((a, b) => (a.key < b.key ? 1 : -1))
}

// Used by the digest to say, truthfully, whether the copy landed.
export async function verifyObject(key, expectedBytes) {
  try {
    const found = (await listObjects(key)).find(o => o.key === key)
    if (!found) return { ok: false, why: 'not found after writing' }
    if (expectedBytes != null && found.bytes !== expectedBytes) {
      return { ok: false, why: `size mismatch: wrote ${expectedBytes}, found ${found.bytes}` }
    }
    return { ok: true, bytes: found.bytes }
  } catch (err) {
    monitor.error('storage.verify', err, { key })
    return { ok: false, why: String(err.message ?? err).slice(0, 200) }
  }
}
