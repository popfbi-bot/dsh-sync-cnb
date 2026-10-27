// Agent-callable tools.
//
// The agent gets read-mostly access: status and a dry-run preview are free,
// push/pull are available but every write is confirmed at the tool boundary and
// a snapshot is taken first. No tool here ever returns or accepts a token.

import { createSnapshot, listSnapshots, restoreSnapshot } from './snapshot.js'
import { scanAll } from './scanner.js'

// defineTool is preferred when the host ships it; the fallback object has the
// same shape so registration works either way.
// 宿主若提供 defineTool 就用它；没有就用同形状的普通对象。
// 不用 top-level await：宿主加载器对 TLA 的支持不一致，而这里只是可选项。
const defineTool = (o) => o

const text = (v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }]

export function registerTools(ctx, engine, { config, logger, requireConfirm } = {}) {
  const tools = []

  tools.push(defineTool({
    name: 'sync_status',
    description: 'Show DSH sync status: machine id, provider, remote repo, per-slice file counts, blocked files, and scheduler state.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute() {
      const status = await engine.status()
      return JSON.stringify({ ...status, scheduler: engine.scheduler?.snapshot?.() ?? null }, null, 2)
    },
  }))

  tools.push(defineTool({
    name: 'sync_preview',
    description: 'Dry-run a pull and report what would change, without writing anything.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute() {
      const r = await engine.pull({ dryRun: true, snapshot: false })
      const lines = r.actions.map((a) => `${a.action}\t${a.rel}${a.conflict ? ` (冲突副本: ${a.conflictFile})` : ''}`)
      return ['预览（未写入）：', ...(lines.length ? lines : ['  无变更'])].join('\n')
    },
  }))

  tools.push(defineTool({
    name: 'sync_now',
    description: 'Push local changes then pull and merge remote changes. Takes a snapshot first.',
    parameters: {
      confirm: { type: 'boolean', description: 'Pass true to actually perform the sync' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args) {
      if (requireConfirm?.(args) === false || !args?.confirm) {
        return '未执行：这是一次写操作，需要显式传入 confirm=true。'
      }
      const pushed = await engine.push()
      const pulled = await engine.pull({})
      return JSON.stringify({ pushed, pulled }, null, 2)
    },
  }))

  tools.push(defineTool({
    name: 'sync_snapshot',
    description: 'Create a local snapshot of everything currently in scope (session logs, settings, skills).',
    parameters: { tag: { type: 'string', description: 'Optional label, e.g. before-upgrade' } },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args) {
      const scanned = await scanAll({ config, machineId: engine.machineId })
      const flat = Object.entries(scanned).flatMap(([k, v]) => v.files.map((f) => ({ slice: k, rel: f.rel, content: f.content })))
      const snap = await createSnapshot(flat, { tag: args?.tag || 'manual', retention: config.snapshotRetention })
      return `快照 ${snap.name} 已创建，包含 ${snap.count} 个文件。`
    },
  }))

  tools.push(defineTool({
    name: 'sync_restore',
    description: 'List snapshots, or restore one by name. Restoring takes a pre-restore snapshot first.',
    parameters: {
      name: { type: 'string', description: 'Snapshot name to restore; omit to list' },
      confirm: { type: 'boolean', description: 'Pass true with a name to actually restore' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args) {
      if (!args?.name) {
        const all = await listSnapshots()
        return all.length ? all.map((s) => s.name).join('\n') : '暂无快照'
      }
      if (!args?.confirm) return `未执行：恢复会覆盖 ${args.name} 中的文件，需要 confirm=true。`
      const pre = await engine.pull({ dryRun: true, snapshot: true }).catch(() => null)
      const r = await restoreSnapshot(args.name)
      return JSON.stringify({ restored: r, preRestoreSnapshot: pre ? 'created' : 'skipped' }, null, 2)
    },
  }))

  tools.push(defineTool({
    name: 'sync_machines',
    description: 'List machines that have a backup directory in the sync repo.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute() {
      return (await engine.listMachines()).join('\n') || '暂无其他机器的备份目录'
    },
  }))

  for (const t of tools) {
    try { ctx.tools.register(t) } catch (err) { logger?.(`[dsh-sync-cnb] 工具 ${t.name} 注册失败：${err}`) }
  }
  return tools.map((t) => t.name)
}
