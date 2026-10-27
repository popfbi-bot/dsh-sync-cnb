// Path / platform helpers.
//
// Two platform traps this module exists to neutralise:
//
// 1. MSYS2 path mangling (Git for Windows). Arguments handed to a native .exe
//    from Git Bash get POSIX->Windows conversion applied. A directory whose name
//    contains a dot (e.g. C:\Users\x\.dsh\dsh-sync-cnb\repo) has that dot
//    treated as a separator, so the path silently rewrites to
//    C:\Users\x\dsh\dsh-sync-cnb\repo and git runs in a directory that does not
//    exist ("fetch failed"). Git for Windows classifies this as wontfix
//    (git-for-windows#685). We neutralise it per git child-process only, never
//    globally -- a global MSYS_NO_PATHCONV breaks unrelated programs.
//
// 2. Absolute paths are machine-local. Nothing we put in the sync payload may
//    contain a machine-specific prefix, or a Windows<->macOS round trip breaks
//    it silently (app starts, individual features quietly stop working).

import { homedir, hostname, platform, tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

export const IS_WINDOWS = platform() === 'win32'
export const PLATFORM_KEY = IS_WINDOWS ? 'win' : platform() === 'darwin' ? 'mac' : 'linux'

/** Stable, human-readable machine label. Never contains a path separator. */
export function machineLabel(explicit = '') {
  if (explicit) return sanitizeSegment(explicit)
  const host = sanitizeSegment(hostname() || 'unknown')
  return `${host}-${PLATFORM_KEY}`
}

/** Collision-resistant suffix for snapshot / conflict naming. */
export function shortId(bytes = 4) {
  return randomBytes(bytes).toString('hex')
}

export function dshHome() {
  const override = process.env.DSH_HOME
  if (override && typeof override === 'string' && override.trim()) return path.resolve(override.trim())
  return path.join(homedir(), '.dsh')
}

export function stateDir() {
  return path.join(dshHome(), 'dsh-sync-cnb')
}

export function repoDir() {
  return path.join(stateDir(), 'repo')
}

export function snapshotDir() {
  return path.join(stateDir(), 'snapshots')
}

export function settingsFile() {
  return path.join(stateDir(), 'settings.json')
}

/** Always POSIX separators -- used as the repo-relative key, so Windows and
 *  macOS produce byte-identical keys for the same logical file. */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/')
}

/** Reject keys that could escape the state dir or collide across platforms. */
export function sanitizeSegment(seg) {
  return String(seg)
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\.+/g, '.')
    .replace(/^\.+/, '')
    .trim()
}

/**
 * Resolve a user-supplied relative root against DSH_HOME, refusing to escape.
 * Returns null when the input is unsafe (absolute, or climbs out).
 */
export function safeResolveRoot(root) {
  const home = dshHome()
  const normalized = toPosix(root)
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null
  const resolved = path.resolve(home, normalized)
  const rel = path.relative(home, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return resolved
}

/**
 * Environment for a git child process.
 *
 * Two things happen here:
 *  - MSYS2 conversion is disabled for this process only (see header note).
 *  - Token is delivered through GIT_ASKPASS, never through argv: argv is world
 *    readable via `ps` on a shared machine.
 */
export function gitChildEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  if (IS_WINDOWS) {
    env.MSYS_NO_PATHCONV = '1'
    env.MSYS2_ARG_CONV_EXCL = '*'
  }
  // Keep git from asking interactively and from reading the user's global
  // config in ways that differ per machine.
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_CONFIG_NOSYSTEM = '1'
  return env
}

/**
 * Write a temp GIT_ASKPASS script and return its path plus the env it needs.
 * `username` is provider-specific: "cnb" on CNB, "x-access-token" for GitHub
 * fine-grained tokens, the login name for classic PATs.
 */
export async function writeAskPass(fs, dir, token, username = 'cnb') {
  await fs.promises.mkdir(dir, { recursive: true })
  const file = path.join(dir, IS_WINDOWS ? 'askpass.cmd' : 'askpass.sh')
  const user = String(username).replace(/[^A-Za-z0-9._-]/g, '')
  const body = IS_WINDOWS
    ? // Git 传给 askpass 的是整句 prompt（"Username for 'https://…': "），
      // 不是裸的 "Username"。原来的等值比较在 Windows 上永远不命中，
      // 导致 push 读不到凭据（Linux 版用的是前缀匹配，所以没暴露）。
      `@echo off\r\nsetlocal\r\nset "P=%~1"\r\necho %P% | findstr /i "username" >nul\r\nif not errorlevel 1 (\r\n  echo ${user}\r\n) else (\r\n  echo %DSH_SYNC_ASKPASS_TOKEN%\r\n)\r\nexit /b 0\r\n`
    : `#!/bin/sh\ncase "$1" in\n  Username*) echo "${user}" ;;\n  Password*) echo "$DSH_SYNC_ASKPASS_TOKEN" ;;\n  *) exit 0 ;;\nesac\n`
  await fs.promises.writeFile(file, body, { mode: IS_WINDOWS ? 0o600 : 0o700 })
  return { file, env: { DSH_SYNC_ASKPASS_TOKEN: token } }
}

export { tmpdir }
