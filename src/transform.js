// Cross-platform path neutralisation.
//
// Session logs and settings.yaml embed absolute paths. A Windows machine stores
// C:\Users\alice\... and a Mac stores /Users/bob\...; syncing them verbatim
// means the other machine reads a path that does not exist -- and the failure is
// silent, the app starts and one feature quietly stops working.
//
// Fix: on the way out, replace every machine-specific absolute prefix with a
// placeholder token. On the way in, expand the tokens for the local machine.
// The repo therefore only ever contains platform-neutral content.

import path from 'node:path'
import { homedir } from 'node:os'
import { dshHome, IS_WINDOWS, toPosix } from './paths.js'

export const TOKENS = {
  DSH_HOME: '{{DSH_HOME}}',
  HOME: '{{HOME}}',
  CWD: '{{CWD}}',
}

/** Build the ordered list of prefixes to neutralise, longest first so that
 *  DSH_HOME wins over HOME. */
export function prefixTable(extraRoots = []) {
  const dsh = dshHome()
  const home = homedir()
  const table = [
    { token: TOKENS.DSH_HOME, abs: dsh },
    { token: TOKENS.HOME, abs: home },
    { token: TOKENS.CWD, abs: process.cwd() },
  ]
  for (const root of extraRoots) {
    if (root && typeof root === 'string') {
      table.push({ token: `{{WS:${path.basename(root)}}}`, abs: root })
    }
  }
  return table
    .filter((e) => e.abs && e.abs.length > 2)
    .sort((a, b) => b.abs.length - a.abs.length)
}

function variantsOf(abs) {
  const posix = toPosix(abs)
  const set = new Set([abs, posix])
  if (IS_WINDOWS) {
    // Windows accepts both separators; logs may contain either.
    set.add(abs.replace(/\\/g, '\\\\'))
  }
  return [...set].filter((s) => s.length > 2).sort((a, b) => b.length - a.length)
}

export function looksBinary(buf) {
  if (!Buffer.isBuffer(buf)) return false
  if (buf.includes(0)) return true
  // Cheap heuristic: lots of control bytes => not text we should rewrite.
  const sample = buf.subarray(0, 4096)
  let ctrl = 0
  for (const b of sample) if (b < 9 || (b > 13 && b < 32)) ctrl++
  return ctrl / Math.max(sample.length, 1) > 0.05
}

/** abs -> tokens. Also neutralises the other platform's separator flavour so a
 *  Windows-written path is recognised on macOS and vice versa. */
export function neutralise(buf, table) {
  if (looksBinary(buf)) return buf
  let text = buf.toString('utf8')
  for (const { token, abs } of table) {
    for (const v of variantsOf(abs)) {
      if (text.includes(v)) text = text.split(v).join(token)
    }
    // Also catch the opposite separator flavour of the same path.
    const flipped = toPosix(abs).includes('/')
      ? toPosix(abs).replace(/\//g, '\\')
      : toPosix(abs)
    if (text.includes(flipped)) text = text.split(flipped).join(token)
  }
  return Buffer.from(text, 'utf8')
}

/** tokens -> this machine's abs paths. */
export function denormalise(buf, table) {
  if (looksBinary(buf)) return buf
  let text = buf.toString('utf8')
  for (const { token, abs } of table) {
    if (text.includes(token)) {
      // Windows: 还原本机原生分隔符（反斜杠）。正斜杠虽然也能被 Node 接受，
      // 但字节级往返会变形，且与 settings.yaml 里原本的写法不一致。
      const local = IS_WINDOWS ? abs : toPosix(abs)
      text = text.split(token).join(local)
    }
  }
  return Buffer.from(text, 'utf8')
}

export { dshHome }
