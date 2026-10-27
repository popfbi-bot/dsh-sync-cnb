// Collect the files that belong to each enabled slice.

import fs from 'node:fs'
import path from 'node:path'
import { dshHome, toPosix } from './paths.js'
import { SLICES, isExcluded, extensionAllowed, remoteKey, classifyRoot } from './slices.js'
import { scanBuffer, gate } from './secrets.js'
import { prefixTable, neutralise } from './transform.js'

const MAX_BYTES = 64 * 1024 * 1024 // refuse to sync anything larger

async function walk(dir, home, out, { skip = new Set() } = {}) {
  let entries
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return // missing root is normal: not every machine has .agents/skills
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    const rel = toPosix(path.relative(home, abs))
    if (skip.has(rel)) continue
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) {
      await walk(abs, home, out, { skip })
      continue
    }
    if (!e.isFile()) continue
    out.push({ abs, rel })
  }
}

async function matchGlob(home, pattern) {
  // Only the "dir/*/file" shape is supported -- enough for profiles/*/package.json.
  const parts = pattern.split('/')
  const starAt = parts.indexOf('*')
  if (starAt === -1) {
    const abs = path.join(home, pattern)
    try {
      const st = await fs.promises.stat(abs)
      return st.isFile() ? [{ abs, rel: toPosix(pattern) }] : []
    } catch { return [] }
  }
  const prefix = parts.slice(0, starAt).join('/')
  const suffix = parts.slice(starAt + 1).join('/')
  const baseDir = path.join(home, prefix)
  let dirs = []
  try {
    dirs = (await fs.promises.readdir(baseDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch { return [] }
  const hits = []
  for (const d of dirs) {
    const abs = path.join(baseDir, d, suffix)
    try {
      const st = await fs.promises.stat(abs)
      if (st.isFile()) hits.push({ abs, rel: toPosix(path.join(prefix, d, suffix)) })
    } catch { /* no package.json in this profile */ }
  }
  return hits
}

/**
 * Scan one slice.
 * @returns {Promise<{ files: Array, blocked: Array, skipped: Array }>}
 */
export async function scanSlice(name, { config, machineId, allowSensitive = false } = {}) {
  const slice = SLICES[name]
  const home = dshHome()
  const table = prefixTable()
  const files = []
  const blocked = []
  const skipped = []

  const candidates = []
  // Roots come from rootMap so the tag/prefix mapping has a single source of truth.
  for (const root of (slice.rootMap || []).map((r) => r.prefix).filter(Boolean)) {
    const abs = path.join(home, root)
    const st = await fs.promises.stat(abs).catch(() => null)
    if (st?.isDirectory()) await walk(abs, home, candidates)
    else if (st?.isFile()) candidates.push({ abs, rel: toPosix(root) })
  }
  for (const pattern of slice.files || []) {
    candidates.push(...(await matchGlob(home, pattern)))
  }

  for (const c of candidates) {
    if (isExcluded(c.rel, config?.exclude, slice.allow)) { skipped.push({ ...c, why: 'excluded' }); continue }
    if (!extensionAllowed(c.rel, slice.extensions)) { skipped.push({ ...c, why: 'extension' }); continue }
    const st = await fs.promises.stat(c.abs).catch(() => null)
    if (!st) { skipped.push({ ...c, why: 'unreadable' }); continue }
    if (st.size > MAX_BYTES) { blocked.push({ ...c, why: `文件超过 ${MAX_BYTES} 字节` }); continue }

    const raw = await fs.promises.readFile(c.abs)
    const findings = scanBuffer(raw, c.rel)
    const verdict = gate(c.rel, findings, { allowSensitive })
    if (!verdict.allow) { blocked.push({ ...c, why: verdict.reason, findings }); continue }

    const classified = classifyRoot(name, c.rel)
    if (!classified) { skipped.push({ ...c, why: 'root-not-mapped' }); continue }

    files.push({
      slice: name,
      rel: c.rel,
      tag: classified.tag,
      relWithin: classified.relWithin,
      abs: c.abs,
      remoteKey: remoteKey(name, classified, machineId),
      size: st.size,
      mtimeMs: st.mtimeMs,
      // Content is neutralised here, once, so the same buffer is used for the
      // working tree, the secret scan and the snapshot.
      content: neutralise(raw, table),
    })
  }

  files.sort((a, b) => a.rel.localeCompare(b.rel))
  return { files, blocked, skipped }
}

export async function scanAll({ config, machineId, allowSensitive = false } = {}) {
  const result = {}
  for (const name of Object.keys(SLICES)) {
    if (config?.enabled && config.enabled[name] === false) continue
    result[name] = await scanSlice(name, { config, machineId, allowSensitive })
  }
  return result
}

export { MAX_BYTES }
