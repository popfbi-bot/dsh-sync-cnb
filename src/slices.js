// What we sync, and -- more importantly -- what we refuse to.
//
// ~/.dsh mixes four kinds of state. Copying the whole directory between a
// Windows box and a Mac breaks all four at once, which is why earlier attempts
// that "just git add the whole thing" ended in 134MB pushes and profiles that
// would not start. Each slice below is scoped to one kind.

import path from 'node:path'
import { dshHome, toPosix } from './paths.js'

export const SLICES = {
  skills: {
    title: '技能',
    desc: 'skills / .agents/skills 下的技能文件',
    // Union by default: two machines each adding a skill should both win.
    defaultStrategy: 'union',
    // Shared across machines -- lives in shared/skills/... in the repo.
    machineScoped: false,
    files: [],
    extensions: ['.md', '.markdown', '.txt', '.json', '.yaml', '.yml'],
    rootMap: [
      { tag: 'skills', prefix: 'skills' },
      { tag: 'dot', prefix: '.agents/skills' },
      { tag: 'agents', prefix: 'agents/skills' },
    ],
  },
  sessions: {
    title: '会话',
    desc: '会话日志与附件',
    defaultStrategy: 'backup',
    // Per-machine: each machine owns backup/<machineId>/sessions/..., so two
    // machines running in parallel can never clobber each other's log.
    machineScoped: true,
    files: [],
    extensions: ['.jsonl', '.jsonl.zstd', '.zstd', '.json', '.md', '.txt', '.log'],
    rootMap: [{ tag: 'log', prefix: 'sessions' }],
  },
  settings: {
    title: '设置',
    desc: 'settings.yaml（模型与界面设置）',
    defaultStrategy: 'backup',
    machineScoped: true,
    files: ['settings.yaml'],
    extensions: ['*'],
    rootMap: [{ tag: 'root', prefix: '' }],
  },
  plugins: {
    title: '插件清单',
    desc: '各 profile 的插件清单（只记清单，不传依赖）',
    defaultStrategy: 'backup',
    machineScoped: true,
    roots: [],
    // package.json only -- node_modules is never transferred.
    roots: [],
    files: ['profiles/*/package.json'],
    rootMap: [{ tag: 'root', prefix: '' }],
    // profiles/ is hard-excluded wholesale (it holds machine-local plugin
    // combos and absolute paths), but the manifest itself is exactly what we
    // want to carry. This allowlist is the narrow exception.
    allow: ['profiles/*/package.json'],
    extensions: ['*'],
  },
}

/**
 * Always excluded, regardless of slice or user config.
 *
 * Rationale, in the order these bite:
 *  - .credentials.yaml       plaintext API keys
 *  - profiles/               machine-local plugin combos + absolute paths;
 *                            overwriting breaks the host's startup chain
 *  - node_modules/           hundreds of MB, platform-specific binaries
 *  - storages/               must never be shared between machines
 *  - workspace.json          rewritten wholesale by each machine; two writers
 *                            silently drop sessions from the sidebar
 *  - session.lock / *.tmp    per-machine artifacts, mid-write garbage
 */
export const HARD_EXCLUDES = [
  '.credentials.yaml',
  'credentials.yaml',
  'profiles/',
  'node_modules/',
  'storages/',
  'workspace.json',
  'session.lock',
  '*.tmp',
  '*.lock',
  '.DS_Store',
  'snapshots/',
  'askpass/',
]

/** Patterns that suggest a secret slipped into a file we were about to upload. */
export const SECRET_HINTS = [
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /gho_[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /BEGIN (RSA |EC |OPENSSH |PRIVATE )?PRIVATE KEY/,
  /(api[_-]?key|apikey|access[_-]?token|secret[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i,
]

const HOME = dshHome()

function matches(key, rule) {
  const r = rule.replace(/\/+$/, '')
  if (!r) return false
  if (r.endsWith('/')) return key === r || key.startsWith(r)
  if (r.includes('*')) {
    const escaped = r.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`).test(key) || new RegExp(`(^|/)${escaped}$`).test(key)
  }
  // Bare name matches at any depth (e.g. "session.lock").
  return key === r || key.endsWith(`/${r}`) || key.startsWith(`${r}/`)
}

/**
 * Is this repo-relative key (POSIX form) excluded by policy?
 * `allow` wins over HARD_EXCLUDES -- that is how the plugin manifest escapes
 * the blanket profiles/ exclusion -- but never over a user's own excludes.
 */
export function isExcluded(relPosix, userExcludes = [], allow = []) {
  const key = relPosix.replace(/^\/+/, '')
  for (const rule of userExcludes) if (matches(key, rule)) return true
  for (const rule of allow) if (matches(key, rule)) return false
  for (const rule of HARD_EXCLUDES) if (matches(key, rule)) return true
  return false
}

export function extensionAllowed(relPosix, extensions) {
  if (!extensions || extensions.includes('*')) return true
  const ext = path.extname(relPosix).toLowerCase()
  return extensions.includes(ext)
}

/**
 * Repo key for a slice + classified root + machine.
 *
 * Shape:  shared/<slice>/<rootTag>/<relWithin>
 *         instances/<machineId>/<slice>/<rootTag>/<relWithin>
 *
 * The root tag is what makes the key reversible: a slice can have several roots
 * (skills lives under skills/, .agents/skills/ or agents/skills/), and without
 * recording which one a file came from there is no way to put it back on a
 * different machine.
 */
export function remoteKey(sliceName, { tag, relWithin }, machineId) {
  const slice = SLICES[sliceName]
  const tail = `${sliceName}/${tag}/${relWithin}`
  return slice.machineScoped ? `instances/${machineId}/${tail}` : `shared/${tail}`
}

/**
 * Reverse of remoteKey.
 * @returns {{scope:string, machine?:string, slice:string, tag:string, relWithin:string}|null}
 */
export function parseRemoteKey(key) {
  const parts = key.split('/')
  if (parts[0] === 'shared' && parts.length >= 4) {
    return { scope: 'shared', slice: parts[1], tag: parts[2], relWithin: parts.slice(3).join('/') }
  }
  if (parts[0] === 'instances' && parts.length >= 5) {
    return {
      scope: 'instances', machine: parts[1], slice: parts[2],
      tag: parts[3], relWithin: parts.slice(4).join('/'),
    }
  }
  return null
}

/** Rebuild the DSH_HOME-relative path from a parsed key. */
export function localRelFor(sliceName, tag, relWithin) {
  const slice = SLICES[sliceName]
  if (!slice) return relWithin
  const entry = (slice.rootMap || []).find((r) => r.tag === tag)
  const prefix = entry ? entry.prefix : ''
  return prefix ? toPosix(path.join(prefix, relWithin)) : relWithin
}

/**
 * Which root does this file belong to?
 * @returns {{tag:string, relWithin:string}|null}
 */
export function classifyRoot(sliceName, rel) {
  const slice = SLICES[sliceName]
  if (!slice) return null
  for (const entry of slice.rootMap || []) {
    if (!entry.prefix) return { tag: entry.tag, relWithin: rel }
    if (rel === entry.prefix) return { tag: entry.tag, relWithin: path.basename(rel) }
    if (rel.startsWith(`${entry.prefix}/`)) {
      return { tag: entry.tag, relWithin: rel.slice(entry.prefix.length + 1) }
    }
  }
  return null
}

export { HOME }
