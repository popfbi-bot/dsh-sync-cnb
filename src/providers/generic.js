// Table-driven provider factory for Gitee / GitLab / GitCode / self-hosted.
//
// These platforms differ only in REST path shape and which JSON field carries
// visibility, so a factory keeps the differences declarative. Unknown hosts get
// `unverifiable: true`, which makes verifyPrivate() return an explicit
// "cannot verify" instead of a false all-clear -- the UI must then ask the user
// to confirm before saving.

import { jsonRequest } from './http.js'
import { hostOf } from './index.js'

export function makeGeneric(spec) {
  const {
    id, label, host, apiBase, gitUsername = 'oauth2', accept = 'application/json',
    repoPath, prPath, mergePath, mergeMethod = 'PUT',
    privateKey = 'private', privateTest, unverifiable = false,
  } = spec

  const defaultRepoPath = (url) => {
    const raw = String(url || '')
    try { return new URL(raw).pathname.replace(/^\/+/, '').replace(/\.git$/, '') } catch { return '' }
  }

  return {
    id,
    label,
    host,
    gitUsername,
    unverifiable,

    matchUrl(url) {
      if (!host) return false
      try { return new URL(url).host.endsWith(host) } catch { return false }
    },

    normalizeUrl(input) {
      const raw = String(input || '').trim()
      if (!raw) return ''
      if (/^https?:\/\//i.test(raw)) return raw.replace(/\.git$/, '')
      const slug = raw.replace(/^\/+/, '').replace(/\.git$/, '')
      return host ? `https://${host}/${slug}` : raw
    },

    repoPath(url) {
      return (repoPath || defaultRepoPath)(this.normalizeUrl(url))
    },

    async verifyPrivate(url, token) {
      if (unverifiable || !apiBase) {
        return {
          ok: true,
          private: null,
          unverified: true,
          reason: '自建或未知托管方，无法校验仓库私有性；确认该仓库为私有后可手动放行',
        }
      }
      const repo = this.repoPath(url)
      if (!repo) return { ok: false, private: false, reason: '仓库地址无法解析' }
      if (!token) return { ok: false, private: false, reason: '未配置访问令牌' }
      const res = await jsonRequest(`${apiBase}/repos/${repo}`, {
        token, headers: { Accept: accept },
      })
      if (!res.ok) return { ok: false, private: false, reason: `无法读取仓库 (HTTP ${res.status})` }
      const j = res.json || {}
      const isPrivate = privateTest ? privateTest(j) : j[privateKey] === true
      return {
        ok: true,
        private: isPrivate,
        reason: isPrivate ? '' : '该仓库不是私有仓库，已拒绝保存',
      }
    },

    async createPr({ url, token, title, body, head, base }) {
      const p = prPath?.(this.repoPath(url))
      if (!p) return { ok: false, reason: `该托管方未提供可用的合并请求接口` }
      const res = await jsonRequest(`${apiBase}${p}`, {
        method: 'POST', token,
        headers: { Accept: accept, 'Content-Type': 'application/json' },
        body: { title, body, head, base },
      })
      if (!res.ok) return { ok: false, reason: `创建合并请求失败 (HTTP ${res.status})` }
      const j = res.json || {}
      return { ok: true, number: j.number ?? j.iid ?? null, url: j.html_url || '' }
    },

    async mergePr({ url, token, number }) {
      const repo = this.repoPath(url)
      const p = mergePath?.(repo, number) || `${prPath(repo)}/${number}/merge`
      const res = await jsonRequest(`${apiBase}${p}`, {
        method: mergeMethod, token,
        headers: { Accept: accept, 'Content-Type': 'application/json' },
        body: {},
      })
      return { ok: res.ok, reason: res.ok ? '' : `合并失败 (HTTP ${res.status})` }
    },
  }
}

export { hostOf }
