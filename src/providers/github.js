// GitHub provider.
//
// Notes that bite people:
//  - A fine-grained PAT authenticates over HTTPS with username
//    "x-access-token" and the token as password. A classic PAT uses the login
//    name. We default to x-access-token, which works for both cases.
//  - `private` is the field to check; a public repo must be rejected outright.
//  - Fine-grained tokens need Contents: read+write, and Pull requests:
//    read+write when PR mode is on.

import { jsonRequest } from './http.js'

const API = (process.env.GITHUB_API_ENDPOINT || 'https://api.github.com').replace(/\/+$/, '')
const HOST = 'github.com'

export const github = {
  id: 'github',
  label: 'GitHub',
  host: HOST,
  gitUsername: 'x-access-token',

  matchUrl(url) {
    try { return new URL(url).host.endsWith(HOST) } catch { return false }
  },

  normalizeUrl(input) {
    const raw = String(input || '').trim()
    if (!raw) return ''
    if (/^https?:\/\//i.test(raw)) return raw.replace(/\.git$/, '')
    const slug = raw.replace(/^[^/]*github\.com\//i, '').replace(/^\/+/, '').replace(/\.git$/, '')
    return `https://${HOST}/${slug}`
  },

  repoPath(url) {
    const normalized = this.normalizeUrl(url)
    try {
      return new URL(normalized).pathname.replace(/^\/+/, '').replace(/\.git$/, '')
    } catch {
      return String(url).replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '')
    }
  },

  async verifyPrivate(url, token) {
    const repo = this.repoPath(url)
    if (!repo) return { ok: false, private: false, reason: '仓库地址无法解析' }
    if (!token) return { ok: false, private: false, reason: '未配置访问令牌' }
    const res = await jsonRequest(`${API}/repos/${repo}`, {
      token,
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!res.ok) return { ok: false, private: false, reason: `无法读取仓库 (HTTP ${res.status})` }
    const j = res.json || {}
    return {
      ok: true,
      private: j.private === true,
      reason: j.private === true ? '' : '该仓库不是私有仓库，已拒绝保存',
    }
  },

  async createPr({ url, token, title, body, head, base }) {
    const repo = this.repoPath(url)
    const res = await jsonRequest(`${API}/repos/${repo}/pulls`, {
      method: 'POST',
      token,
      headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: { title, body, head, base },
    })
    if (!res.ok) return { ok: false, reason: `创建 PR 失败 (HTTP ${res.status})` }
    const j = res.json || {}
    return { ok: true, number: j.number ?? null, url: j.html_url || '' }
  },

  async mergePr({ url, token, number }) {
    const repo = this.repoPath(url)
    const res = await jsonRequest(`${API}/repos/${repo}/pulls/${number}/merge`, {
      method: 'PUT',
      token,
      headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: { merge_method: 'merge' },
    })
    return { ok: res.ok, reason: res.ok ? '' : `合并失败 (HTTP ${res.status})` }
  },
}
