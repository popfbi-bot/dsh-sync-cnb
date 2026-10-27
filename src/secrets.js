// Outbound secret scan.
//
// The dedicated credentials file is excluded by policy, but that is not enough:
// users paste keys into conversations, and a session log will happily carry one
// into a private repo. This module is the last gate before anything leaves the
// machine. It never modifies content silently -- it reports findings and lets
// the caller decide (block by default).

import { SECRET_HINTS } from './slices.js'
import path from 'node:path'

const ALLOWLIST_FILENAMES = new Set(['.env.example', 'example.env', 'README.md'])

export function scanText(text, relPosix = '') {
  const base = path.basename(relPosix).toLowerCase()
  if (ALLOWLIST_FILENAMES.has(base)) return []
  const findings = []
  for (const re of SECRET_HINTS) {
    const m = re.exec(text)
    if (m) findings.push({ pattern: re.source.slice(0, 40), sample: mask(m[0]) })
  }
  return findings
}

export function scanBuffer(buf, relPosix = '') {
  // Binary files are not scanned; they are also never path-rewritten.
  if (Buffer.isBuffer(buf) && buf.includes(0)) return []
  return scanText(buf.toString('utf8'), relPosix)
}

export function mask(s) {
  const str = String(s)
  if (str.length <= 8) return '***'
  return `${str.slice(0, 3)}***${str.slice(-2)}`
}

/**
 * Decide whether a file may be uploaded.
 * @returns {{ allow: boolean, findings: Array, reason: string }}
 */
export function gate(relPosix, findings, { allowSensitive = false } = {}) {
  if (!findings.length) return { allow: true, findings: [], reason: '' }
  if (allowSensitive) return { allow: true, findings, reason: '已由用户放行的疑似敏感内容' }
  return {
    allow: false,
    findings,
    reason: `${relPosix} 疑似包含密钥（${findings.map((f) => f.sample).join('、')}），已阻止上传`,
  }
}
