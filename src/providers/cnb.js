// CNB (cnb.cool) provider.
//
// CNB specifics that matter here:
//  - HTTPS + access token only; SSH is not supported at all.
//  - git username is literally "cnb", password is the access token.
//  - REST needs Accept: application/vnd.cnb.api+json.
//  - Default token permissions grant read on public resources and NOTHING on
//    private repos, so a fresh token must be granted repo-code:rw explicitly.
//  - Repo path in REST is the same "group/repo" as in the URL.

import { jsonRequest } from './http.js'

const API = (process.env.CNB_API_ENDPOINT || 'https://api.cnb.cool').replace(/\/+$/, '')
const HOST = 'cnb.cool'

export const cnb = {
  id: 'cnb',
  label: 'CNB',
  host: HOST,
  gitUsername: 'cnb',

  matchUrl(url) {
    try { return new URL(url).host.endsWith(HOST) } catch { return false }
  },

  /** Accept "group/repo", "cnb.cool/group/repo", or a full https URL. */
  normalizeUrl(input) {
    const raw = String(input || '').trim()
    if (!raw) return ''
    if (/^https?:\/\//i.test(raw)) return raw.replace(/\.git$/, '')
    const slug = raw.replace(/^[^/]*cnb\.cool\//i, '').replace(/^\/+/, '').replace(/\.git$/, '')
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
    const res = await jsonRequest(`${API}/${repo}`, {
      token,
      headers: { Accept: 'application/vnd.cnb.api+json' },
    })
    if (!res.ok) {
      return { ok: false, private: false, reason: `无法读取仓库 (HTTP ${res.status})，请检查令牌是否勾选了私有仓库权限` }
    }
    const j = res.json || {}
    // CNB 现在的字段是 visibility_level（"Private"/"Public"）；
    // 旧实现只认 visibility/private/public，会把私有库误判成公开库并拒绝保存。
    const level = String(j.visibility_level || j.visibility || '').toLowerCase()
    const isPrivate = j.public === false || j.private === true || level === 'private'
    return {
      ok: true,
      private: isPrivate,
      reason: isPrivate ? '' : '该仓库不是私有仓库，已拒绝保存',
    }
  },

  async createPr({ url, token, title, body, head, base }) {
    const repo = this.repoPath(url)
    const res = await jsonRequest(`${API}/${repo}/-/pulls`, {
      method: 'POST',
      token,
      headers: { Accept: 'application/vnd.cnb.api+json', 'Content-Type': 'application/json' },
      body: { title, body, head, base },
    })
    if (!res.ok) return { ok: false, reason: `创建合并请求失败 (HTTP ${res.status})` }
    const j = res.json || {}
    return { ok: true, number: j.number ?? j.iid ?? null, url: j.html_url || j.url || '' }
  },

  async mergePr({ url, token, number }) {
    const repo = this.repoPath(url)
    const res = await jsonRequest(`${API}/${repo}/-/pulls/${number}/merge`, {
      method: 'PUT',
      token,
      headers: { Accept: 'application/vnd.cnb.api+json', 'Content-Type': 'application/json' },
      body: {},
    })
    return { ok: res.ok, reason: res.ok ? '' : `合并失败 (HTTP ${res.status})` }
  },
}
