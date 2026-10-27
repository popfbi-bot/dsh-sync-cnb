// dsh-sync-cnb -- multi-machine sync for DeepSeek Harness.
//
// Plugin entry. Everything durable lives in the modules; this file only wires
// the Cordis contract: declare dependencies, register capabilities, and make
// sure every resource is released when the fiber is disposed.

import { normalizeConfig, resolveSecret } from './config.js'
import { SyncEngine } from './sync.js'
import { Scheduler } from './scheduler.js'
import { registerTools } from './tools.js'
import { registerPanel } from './panel.js'
import { stateDir, settingsFile, machineLabel } from './paths.js'
import fs from 'node:fs'
import path from 'node:path'

export const name = 'dsh-sync-cnb'

// sessionPersistence is optional: some hosts mount it late or not at all.
// We do not block on it -- sync must work on a headless profile too.
export const inject = []

const DEFAULT_LOGGER = (msg) => {
  try { process.stdout.write(`${msg}\n`) } catch { /* ignore */ }
}

export function apply(ctx, rawConfig = {}) {
  // 插件挂载失败绝不能拖累宿主启动：收成「不激活 + 一条日志」。
  try {
    return applyInner(ctx, rawConfig)
  } catch (err) {
    try {
      ctx?.logger?.error?.(`[dsh-sync-cnb] 挂载失败，插件保持不激活：${(err && err.stack) || err}`)
    } catch {
      /* 日志失败也不再抛 */
    }
    return { plugin: 'dsh-sync-cnb', ok: false, error: String((err && err.message) || err) }
  }
}

function applyInner(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx?.logger?.info ? (m) => ctx.logger.info(m) : DEFAULT_LOGGER
  const token = resolveSecret(config)

  const engine = new SyncEngine({ config, token, logger })
  const scheduler = new Scheduler({
    intervalMinutes: config.autoSyncMinutes,
    logger,
    run: async () => {
      await engine.push()
      return engine.pull({})
    },
  })
  engine.scheduler = scheduler

  logger(`[dsh-sync-cnb] 已加载：机器 ${engine.machineId}，托管方 ${engine.provider.id}，仓库 ${engine.remoteUrl || '(未配置)'}`)

  if (!config.repoUrl) {
    logger('[dsh-sync-cnb] 尚未配置同步仓库：请在设置 → 同步 中填写仓库地址与令牌后将 repoUrl 写入配置')
  }

  // ---- tools -------------------------------------------------------------
  if (ctx.tools?.register) {
    const registered = registerTools(ctx, engine, {
      config,
      logger,
      requireConfirm: () => true,
    })
    logger(`[dsh-sync-cnb] 已注册工具：${registered.join(', ')}`)
  } else {
    ctx.inject?.(['tools'], (c) => {
      registerTools(c, engine, { config, logger, requireConfirm: () => true })
    })
  }

  // ---- settings persistence ---------------------------------------------
  // Machine-local settings (repoUrl, branch, provider, machineId) are written
  // next to the state dir at 0600. Secrets never land in this file.
  const persistSettings = async () => {
    try {
      await fs.promises.mkdir(stateDir(), { recursive: true })
      await fs.promises.writeFile(settingsFile(), JSON.stringify({
        provider: config.provider,
        repoUrl: config.repoUrl,
        branch: config.branch,
        machineId: config.machineId || machineLabel(),
        slices: config.slices,
        enabled: config.enabled,
        autoSyncMinutes: config.autoSyncMinutes,
        conflictMode: config.conflictMode,
        snapshotRetention: config.snapshotRetention,
      }, null, 2), { mode: 0o600 })
    } catch (err) {
      logger(`[dsh-sync-cnb] 设置持久化失败：${err}`)
    }
  }

  // ---- background sync on session activity -------------------------------
  if (ctx.on) {
    try {
      ctx.on('session/end', () => {
        if (!config.autoSyncMinutes) return
        scheduler._tick()
      })
    } catch { /* event not available on this host */ }
  }

  // ---- web panel ---------------------------------------------------------
  const mountPanel = (webCtx) => {
    registerPanel(ctx, webCtx.webServer, engine, { config, logger, scheduler })
  }
  if (ctx.webServer) {
    mountPanel(ctx)
  } else {
    ctx.inject?.(['webServer'], (webCtx) => mountPanel(webCtx))
  }

  // ---- scheduler lifecycle ----------------------------------------------
  scheduler.start()
  ctx.effect?.(() => () => {
    scheduler.stop()
    logger('[dsh-sync-cnb] 已卸载，定时器已清理')
  }, 'dsh-sync-cnb.scheduler')

  void persistSettings()

  // 只返回可序列化的摘要：把 engine/scheduler 这类带闭包的对象交给宿主，
  // 某些宿主会尝试记录/序列化插件返回值，容易在启动期炸掉。
  return {
    plugin: 'dsh-sync-cnb',
    ok: true,
    machineId: engine.machineId,
    provider: engine.provider.id,
    repoUrl: engine.remoteUrl || '',
  }
}

export default { name, inject, apply }

export { path }
