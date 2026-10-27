// Provider registry.
//
// A provider answers exactly five questions. Everything else -- commit, push,
// fetch, three-way merge, conflict copies -- is provider-agnostic and lives in
// sync.js. That is what lets one engine serve CNB and GitHub at once: the only
// real differences are the URL shape, the git username, and two REST calls.
//
//   id              stable key used in config
//   label           display name
//   gitUsername     what GIT_ASKPASS echoes for "Username"
//   matchUrl(url)   does this raw URL belong to me?
//   normalizeUrl()  accept "group/repo" or a full URL, return a clone URL
//   repoPath(url)   "group/repo" for REST calls
//   verifyPrivate() refuse to save against a public repo
//   createPr()      optional; returns { number, url }
//   mergePr()       optional

import { cnb } from './cnb.js'
import { github } from './github.js'
import { makeGeneric } from './generic.js'

export const providers = {
  cnb,
  github,
  gitee: makeGeneric({
    id: 'gitee',
    label: 'Gitee',
    host: 'gitee.com',
    apiBase: 'https://gitee.com/api/v5',
    gitUsername: 'oauth2',
    accept: 'application/json',
    prPath: (repo) => `/repos/${repo}/pulls`,
    privateKey: 'private',
  }),
  gitlab: makeGeneric({
    id: 'gitlab',
    label: 'GitLab',
    host: 'gitlab.com',
    apiBase: 'https://gitlab.com/api/v4',
    gitUsername: 'oauth2',
    accept: 'application/json',
    // GitLab needs the URL-encoded project path.
    repoPath: (url) => encodeURIComponent(url.replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '')),
    prPath: (repo) => `/projects/${repo}/merge_requests`,
    mergePath: (repo, n) => `/projects/${repo}/merge_requests/${n}/merge`,
    mergeMethod: 'PUT',
    privateKey: null, // visibility lives under `visibility`
    privateTest: (json) => json && json.visibility === 'private',
  }),
  gitcode: makeGeneric({
    id: 'gitcode',
    label: 'GitCode',
    host: 'gitcode.net',
    apiBase: 'https://api.gitcode.com/api/v5',
    gitUsername: 'oauth2',
    accept: 'application/json',
    prPath: (repo) => `/repos/${repo}/pulls`,
    privateKey: 'private',
  }),
}

export const PROVIDER_IDS = Object.keys(providers)

export function getProvider(idOrUrl = '') {
  const key = String(idOrUrl || '').trim().toLowerCase()
  if (providers[key]) return providers[key]
  for (const p of Object.values(providers)) {
    try { if (p.matchUrl(key)) return p } catch { /* ignore */ }
  }
  // Unknown host: treated as self-hosted. Privacy cannot be verified, so
  // verifyPrivate() will return `unverified` and the caller must ask the user.
  return makeGeneric({
    id: 'selfhost',
    label: 'Self-hosted',
    host: hostOf(key),
    apiBase: '',
    gitUsername: 'oauth2',
    accept: 'application/json',
    prPath: () => '',
    privateKey: null,
    unverifiable: true,
  })
}

export function hostOf(url) {
  try { return new URL(url).host } catch { return '' }
}

export { cnb, github }
