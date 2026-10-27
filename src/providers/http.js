// Minimal JSON-over-HTTPS helper for provider REST calls.
// Used only for: private-repo verification, PR create/merge. Never for file
// content -- that always goes through git, so a provider REST outage cannot
// corrupt the sync and a REST change cannot change what lands on disk.

export async function jsonRequest(url, {
  method = 'GET',
  token = '',
  headers = {},
  body = null,
  timeoutMs = 20_000,
  okStatus = [200, 201],
} = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'dsh-sync-cnb',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === null ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    return {
      ok: okStatus.includes(res.status),
      status: res.status,
      json,
      text,
    }
  } catch (err) {
    return { ok: false, status: 0, json: null, text: String(err?.message || err), error: err }
  } finally {
    clearTimeout(timer)
  }
}
