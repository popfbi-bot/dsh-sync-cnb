// Settings panel.
//
// Web hosts differ in how they expose an HTTP surface, so we probe for the
// common shapes instead of assuming one. If none is found the plugin still
// works -- the agent tools and the CLI paths remain available.

import { listSnapshots } from './snapshot.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function pickRouter(server) {
  if (!server) return null
  if (typeof server.registerRoutes === 'function') return { kind: 'registerRoutes', server }
  if (typeof server.get === 'function' && typeof server.post === 'function') return { kind: 'getpost', server }
  if (server.app && typeof server.app.get === 'function') return { kind: 'express', server: server.app }
  if (typeof server.route === 'function') return { kind: 'route', server }
  // DeepSeek Harness: webServer.register({ kind: 'exact', path, handler })
  if (typeof server.register === 'function') return { kind: 'dsh-register', server }
  return null
}

export function registerPanel(ctx, webServer, engine, { config, logger, scheduler } = {}) {
  const router = pickRouter(webServer)
  if (!router) {
    logger?.('[dsh-sync-cnb] 未找到可用的 HTTP 路由接口，跳过设置面板（工具与命令行仍可用）')
    return { registered: false, routes: [] }
  }

  const routes = []
  const handle = async (fn) => {
    try {
      const value = await fn()
      return { status: 200, body: value }
    } catch (err) {
      return { status: 500, body: { error: String(err?.message || err) } }
    }
  }

  const bind = (method, pathStr, fn) => {
    routes.push(`${method.toUpperCase()} ${pathStr}`)
    const wrapped = async (req, res) => {
      const out = await handle(fn)
      if (res?.writeHead) res.writeHead(out.status, JSON_HEADERS)
      if (res?.end) res.end(JSON.stringify(out.body))
      return out
    }
    try {
      if (router.kind === 'registerRoutes') router.server.registerRoutes({ method, path: pathStr, handler: wrapped })
      else if (router.kind === 'getpost') router.server[method.toLowerCase()](pathStr, wrapped)
      else if (router.kind === 'express') router.server[method.toLowerCase()](pathStr, wrapped)
      else if (router.kind === 'dsh-register') router.server.register({ kind: 'exact', path: pathStr, handler: wrapped })
      else router.server.route({ method, path: pathStr, handler: wrapped })
    } catch (err) {
      logger?.(`[dsh-sync-cnb] 路由 ${method} ${pathStr} 注册失败：${err}`)
    }
  }

  // Status: never includes the token. Only "configured / not configured".
  bind('get', '/api/dsh-sync-cnb/status', async () => ({
    ...(await engine.status()),
    tokenConfigured: Boolean(engine.token),
    scheduler: scheduler?.snapshot?.() ?? null,
  }))

  bind('get', '/api/dsh-sync-cnb/snapshots', async () => (await listSnapshots()).map((s) => s.name))

  bind('post', '/api/dsh-sync-cnb/verify', async () => engine.verifyRemote({ requirePrivate: true }))

  bind('post', '/api/dsh-sync-cnb/preview', async () => engine.pull({ dryRun: true, snapshot: false }))

  bind('post', '/api/dsh-sync-cnb/sync', async () => {
    const pushed = await engine.push()
    const pulled = await engine.pull({})
    return { pushed, pulled }
  })

  bind('post', '/api/dsh-sync-cnb/snapshot', async () => {
    const { createSnapshot } = await import('./snapshot.js')
    const { scanAll } = await import('./scanner.js')
    const scanned = await scanAll({ config, machineId: engine.machineId })
    const flat = Object.entries(scanned).flatMap(([k, v]) => v.files.map((f) => ({ slice: k, rel: f.rel, content: f.content })))
    return createSnapshot(flat, { tag: 'panel', retention: config.snapshotRetention })
  })

  bind('get', '/api/dsh-sync-cnb/machines', async () => engine.listMachines())

  logger?.(`[dsh-sync-cnb] 设置面板已注册 ${routes.length} 个路由`)
  return { registered: true, routes }
}
