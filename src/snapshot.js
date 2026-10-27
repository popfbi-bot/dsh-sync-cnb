// Local-first snapshots.
//
// Design rules carried over from what actually works in this ecosystem:
//  - a snapshot is local by default; uploading is opt-in
//  - before any restore we take another snapshot (pre-restore-*) so a bad
//    restore is itself reversible
//  - retention is rolling: keep the newest N plus one per month
//  - snapshots record neutralised content, so they are portable

import fs from 'node:fs'
import path from 'node:path'
import { snapshotDir, dshHome, shortId, toPosix } from './paths.js'

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export async function listSnapshots() {
  const dir = snapshotDir()
  let entries = []
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const abs = path.join(dir, e.name)
    const st = await fs.promises.stat(abs).catch(() => null)
    out.push({ name: e.name, abs, mtimeMs: st?.mtimeMs || 0 })
  }
  return out.sort((a, b) => b.name.localeCompare(a.name)) // newest stamp first
}

/**
 * @param {Array<{slice:string, rel:string, content:Buffer}>} files
 * @param {{ tag?: string, retention?: number }} opts
 */
export async function createSnapshot(files, { tag = 'manual', retention = 30 } = {}) {
  const name = `${stamp()}-${tag}-${shortId(3)}`
  const dir = path.join(snapshotDir(), name)
  await fs.promises.mkdir(dir, { recursive: true })

  const written = []
  for (const f of files) {
    const dest = path.join(dir, toPosix(f.rel))
    await fs.promises.mkdir(path.dirname(dest), { recursive: true })
    await fs.promises.writeFile(dest, f.content)
    written.push({ slice: f.slice, rel: f.rel, dest })
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    tag,
    machine: process.platform,
    // Relative to DSH_HOME, never absolute -- keeps snapshots portable.
    files: written.map((w) => ({ slice: w.slice, rel: w.rel })),
  }
  await fs.promises.writeFile(
    path.join(dir, 'snapshot.json'),
    JSON.stringify(manifest, null, 2),
    { mode: 0o600 },
  )

  await pruneSnapshots(retention)
  return { name, dir, count: written.length, manifest }
}

/** Rolling retention: newest N always stay, plus the newest of each month. */
export async function pruneSnapshots(retention = 30) {
  const all = await listSnapshots()
  if (!all.length) return { removed: [] }
  const keep = new Set(all.slice(0, retention).map((s) => s.name))
  const perMonth = new Map()
  for (const s of all) {
    const month = s.name.slice(0, 6)
    if (!perMonth.has(month)) perMonth.set(month, s.name)
  }
  for (const n of perMonth.values()) keep.add(n)

  const removed = []
  for (const s of all) {
    if (keep.has(s.name)) continue
    await fs.promises.rm(s.abs, { recursive: true, force: true }).catch(() => {})
    removed.push(s.name)
  }
  return { removed }
}

export async function readSnapshotManifest(name) {
  const p = path.join(snapshotDir(), name, 'snapshot.json')
  const raw = await fs.promises.readFile(p, 'utf8').catch(() => null)
  return raw ? JSON.parse(raw) : null
}

/**
 * Restore a snapshot into DSH_HOME.
 * Always preceded by a pre-restore snapshot taken by the caller (sync.js).
 */
export async function restoreSnapshot(name, { dryRun = false } = {}) {
  const manifest = await readSnapshotManifest(name)
  if (!manifest) return { ok: false, reason: `快照 ${name} 不存在或已损坏` }
  const home = dshHome()
  const planned = []
  for (const f of manifest.files) {
    const src = path.join(snapshotDir(), name, toPosix(f.rel))
    const dest = path.join(home, toPosix(f.rel))
    const exists = await fs.promises.stat(src).then(() => true).catch(() => false)
    planned.push({ rel: f.rel, src, dest, available: exists })
  }
  if (dryRun) return { ok: true, dryRun: true, planned, manifest }

  let applied = 0
  for (const p of planned) {
    if (!p.available) continue
    await fs.promises.mkdir(path.dirname(p.dest), { recursive: true })
    await fs.promises.writeFile(p.dest, await fs.promises.readFile(p.src))
    applied++
  }
  return { ok: true, applied, planned, manifest }
}

export { dshHome }
