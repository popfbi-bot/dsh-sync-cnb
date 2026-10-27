// Sync engine.
//
// Repository layout -- one branch, two namespaces:
//
//   shared/<slice>/<rel>                  union slices (skills). May conflict;
//                                         resolved by three-way merge.
//   instances/<machineId>/<slice>/<rel>   per-machine slices (sessions,
//                                         settings, plugin manifests).
//                                         Each machine owns exactly one
//                                         directory, so parallel machines can
//                                         never clobber each other.
//   .dsh-sync/state.json                  bookkeeping (never secret-bearing)
//
// Why a single branch with per-machine directories, instead of a branch per
// machine: with several machines pushing at arbitrary times, branch-per-machine
// turns every sync into a rebase war and the shared part still needs merging.
// Namespacing by machine ID makes the common case conflict-free at the git
// level, so git never has to resolve anything -- our three-way merge runs
// before the commit, on content we control.
//
// Key property: the sidecar working tree is a *generated artifact*. We are free
// to reset it from the remote on every round. That is what makes "fetch, reset,
// re-materialise, push" safe, and it is why this engine needs no git merge and
// produces no merge commits.

import fs from 'node:fs'
import path from 'node:path'
import { Git } from './git.js'
import { repoDir, stateDir, dshHome, machineLabel, toPosix } from './paths.js'
import { scanAll } from './scanner.js'
import { SLICES, parseRemoteKey, localRelFor } from './slices.js'
import { threeWay, conflictName } from './merge.js'
import { createSnapshot, listSnapshots } from './snapshot.js'
import { prefixTable, denormalise, neutralise } from './transform.js'
import { getProvider } from './providers/index.js'

const BASE_DIR = 'base'
const STATE_FILE = '.dsh-sync/state.json'
const LOCAL_BRANCH = 'work'
const KNOWN_PROVIDERS = ['cnb', 'github', 'gitee', 'gitlab', 'gitcode', 'selfhost']

export class SyncEngine {
  constructor({ config, token = '', logger } = {}) {
    this.config = config
    this.token = token
    this.logger = logger || (() => {})
    this.machineId = machineLabel(config.machineId)
    // An explicit provider id wins; otherwise infer from the repo URL, so a
    // typo in one field cannot silently push to the wrong backend.
    this.provider = getProvider(
      KNOWN_PROVIDERS.includes(config.provider) ? config.provider : (config.repoUrl || config.provider),
    )
    this.repo = repoDir()
    this.git = new Git({
      dir: this.repo,
      token: this.token,
      username: this.provider.gitUsername || 'cnb',
      logger: this.logger,
    })
    this.basePath = path.join(stateDir(), BASE_DIR)
  }

  get remoteUrl() { return this.provider.normalizeUrl(this.config.repoUrl) }
  get remoteBranch() { return this.config.branch || 'main' }
  get remoteRef() { return `origin/${this.remoteBranch}` }
  get pushRef() { return this.config.prMode ? `dsh/${this.machineId}` : this.remoteBranch }

  // ---------------------------------------------------------------- bootstrap

  async ensureRepo() {
    const url = this.remoteUrl
    if (!url) throw new Error('未配置同步仓库地址（repoUrl）')
    if (!(await this.git.isRepo())) {
      await this.git.init(LOCAL_BRANCH)
    }
    await this.git.ensureIdentity()
    await this.git.setRemote(url)
    const verified = await this.git.verifyDir()
    if (!verified.ok) throw new Error(`同步仓库目录不可用：${verified.reason}`)
    return verified
  }

  async verifyRemote({ requirePrivate = true } = {}) {
    const url = this.remoteUrl
    if (!url) return { ok: false, reason: '未配置同步仓库地址' }
    const res = await this.provider.verifyPrivate(url, this.token)
    if (!res.ok) return res
    if (requirePrivate && res.private === false) return { ...res, ok: false }
    return res
  }

  /** Reset the sidecar tree onto the remote (no-op when the remote is empty). */
  async resetToRemote() {
    await this.git.fetch(this.remoteBranch).catch(() => ({ ok: false }))
    const has = await this.git.run(['rev-parse', '--verify', this.remoteRef], { allowFail: true })
    if (!has.ok) return { hasRemote: false }
    // Forced on purpose -- this tree is generated, there is nothing to lose.
    const r = await this.git.run(['checkout', '-f', '-B', LOCAL_BRANCH, this.remoteRef], { allowFail: true })
    if (!r.ok) throw new Error(`无法切换到远端基线：${r.stderr}`)
    return { hasRemote: true }
  }

  // -------------------------------------------------------------------- state

  async loadState() {
    const p = path.join(this.repo, STATE_FILE)
    const raw = await fs.promises.readFile(p, 'utf8').catch(() => null)
    return raw ? JSON.parse(raw) : { machineId: this.machineId, lastSync: null, keys: {} }
  }

  async saveState(state) {
    const p = path.join(this.repo, STATE_FILE)
    await fs.promises.mkdir(path.dirname(p), { recursive: true })
    await fs.promises.writeFile(p, JSON.stringify(state, null, 2), { mode: 0o600 })
  }

  async baseFor(key) {
    return fs.promises.readFile(path.join(this.basePath, key)).catch(() => null)
  }

  async writeBase(key, buf) {
    const p = path.join(this.basePath, key)
    await fs.promises.mkdir(path.dirname(p), { recursive: true })
    await fs.promises.writeFile(p, buf)
  }

  // ---------------------------------------------------------------- writing

  async writeRepoFile(relKey, buf) {
    const dest = path.join(this.repo, toPosix(relKey))
    await fs.promises.mkdir(path.dirname(dest), { recursive: true })
    await fs.promises.writeFile(dest, buf)
  }

  async writeHomeFile(rel, buf) {
    const dest = path.join(dshHome(), toPosix(rel))
    await fs.promises.mkdir(path.dirname(dest), { recursive: true })
    await fs.promises.writeFile(dest, buf)
  }

  async remoteKeysUnder(prefix) {
    const r = await this.git.run(['ls-tree', '-r', '--name-only', this.remoteRef], { allowFail: true })
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean).filter((k) => k.startsWith(prefix))
  }

  // --------------------------------------------------------------------- push

  /**
   * Full round: fetch, reset, merge shared content, materialise, commit, push.
   * Conflicts in shared/ keep the local version and park the remote one as
   * <file>.conflictN in DSH_HOME.
   */
  async sync({ message, dryRun = false } = {}) {
    await this.ensureRepo()
    const { hasRemote } = await this.resetToRemote()
    const scanned = await scanAll({ config: this.config, machineId: this.machineId })
    const blocked = Object.entries(scanned).flatMap(([k, v]) => v.blocked.map((b) => ({ slice: k, ...b })))

    const table = prefixTable()
    const conflicts = []
    const actions = []

    // 1. shared slices: three-way merge against the remote copy.
    for (const [sliceName, result] of Object.entries(scanned)) {
      if (SLICES[sliceName]?.machineScoped) continue
      for (const f of result.files) {
        let theirs = null
        if (hasRemote) {
          const raw = await this.git.showFile(this.remoteRef, f.remoteKey)
          theirs = raw == null ? null : Buffer.from(raw, 'utf8')
        }
        const base = await this.baseFor(f.remoteKey)
        const decision = threeWay({
          base,
          ours: f.content,
          theirs,
          strategy: this.config.slices?.[sliceName] || SLICES[sliceName].defaultStrategy,
          conflictMode: this.config.conflictMode,
          rel: f.rel,
        })
        actions.push({ key: f.remoteKey, rel: f.rel, slice: sliceName, action: decision.action, conflict: decision.conflict })
        if (decision.content != null) await this.writeRepoFile(f.remoteKey, decision.content)
        await this.writeBase(f.remoteKey, decision.content ?? f.content)

        if (decision.conflict && theirs != null) {
          const cf = await nextConflictName(dshHome(), f.rel)
          conflicts.push({ rel: f.rel, slice: sliceName, conflictFile: cf })
          if (!dryRun) await this.writeHomeFile(cf, denormalise(theirs, table))
        }
        // Local file stays as-is on conflict; on take-remote we write it back.
        if (!dryRun && decision.action === 'take-remote' && decision.content != null) {
          await this.writeHomeFile(f.rel, denormalise(decision.content, table))
        }
      }
    }

    // 2. per-machine slices: we own this directory, write it straight through.
    for (const [sliceName, result] of Object.entries(scanned)) {
      if (!SLICES[sliceName]?.machineScoped) continue
      for (const f of result.files) {
        await this.writeRepoFile(f.remoteKey, f.content)
        await this.writeBase(f.remoteKey, f.content)
        actions.push({ key: f.remoteKey, rel: f.rel, slice: sliceName, action: 'write-own', conflict: false })
      }
    }

    if (dryRun) {
      return { ok: true, dryRun: true, actions, conflicts, blocked, perSlice: counts(scanned) }
    }

    await this.git.addAll()
    const committed = await this.git.commit(message || `sync(${this.machineId}): ${actions.length} changes`)
    let pushed = { ok: true, noop: true }
    if (!committed.noop) {
      pushed = await this.git.push(this.pushRef)
      // Someone pushed while we were working: rebase once, then push again.
      if (!pushed.ok && /non-fast-forward|rejected/i.test(pushed.stderr)) {
        await this.resetToRemote()
        await this.git.addAll()
        await this.git.commit(message || `sync(${this.machineId}) retry`)
        pushed = await this.git.push(this.pushRef)
      }
    } else {
      // 本地没有新提交，不代表远端已经有：上一次 push 可能因凭据失败而中断，
      // 留下一个只在本地的 commit。noop 时补推一次，git 会自己判 up-to-date。
      pushed = await this.git.push(this.pushRef)
    }

    const state = await this.loadState()
    state.machineId = this.machineId
    state.lastSync = new Date().toISOString()
    state.keys = Object.fromEntries(actions.map((a) => [a.key, { at: state.lastSync }]))
    await this.saveState(state)

    return {
      ok: true,
      pushed: !committed.noop,
      noop: Boolean(committed.noop),
      changes: actions.length,
      perSlice: counts(scanned),
      blocked,
      conflicts,
      actions,
      remote: this.remoteUrl,
      ref: this.pushRef,
    }
  }

  /** Backwards-compatible alias: push == one sync round. */
  async push(opts) { return this.sync(opts) }

  // --------------------------------------------------------------------- pull

  /**
   * Apply remote shared content to this machine without pushing.
   * Per-machine slices are NOT touched -- that is what keeps parallel machines
   * safe. Use restoreFromMachine() for an explicit cross-machine restore.
   */
  async pull({ dryRun = false, snapshot = true } = {}) {
    await this.ensureRepo()
    const { hasRemote } = await this.resetToRemote()
    if (!hasRemote) return { ok: true, dryRun: Boolean(dryRun), actions: [], conflicts: [], note: '远端仓库为空' }

    const table = prefixTable()
    const actions = []
    const conflicts = []

    if (snapshot) {
      const flat = await this.localFiles()
      await createSnapshot(flat, { tag: 'pre-pull', retention: this.config.snapshotRetention })
    }

    for (const key of await this.remoteKeysUnder('shared/')) {
      const parsed = parseRemoteKey(key)
      if (!parsed) continue
      if (this.config.enabled?.[parsed.slice] === false) continue

      const raw = await this.git.showFile(this.remoteRef, key)
      if (raw == null) continue
      const theirs = Buffer.from(raw, 'utf8')
      const localRel = localRelFor(parsed.slice, parsed.tag, parsed.relWithin)
      const oursRaw = await fs.promises.readFile(path.join(dshHome(), toPosix(localRel))).catch(() => null)
      const ours = oursRaw ? neutralise(oursRaw, table) : null
      const base = await this.baseFor(key)

      const decision = threeWay({
        base,
        ours,
        theirs,
        strategy: this.config.slices?.[parsed.slice] || SLICES[parsed.slice]?.defaultStrategy || 'backup',
        conflictMode: this.config.conflictMode,
        rel: parsed.rel,
      })
      if (decision.action === 'identical' || decision.action === 'noop') continue

      const entry = { key, rel: localRel, slice: parsed.slice, action: decision.action, conflict: decision.conflict }
      actions.push(entry)

      if (decision.conflict) {
        entry.conflictFile = await nextConflictName(dshHome(), parsed.rel)
        conflicts.push(entry)
        if (!dryRun && theirs != null) await this.writeHomeFile(entry.conflictFile, denormalise(theirs, table))
      }
      if (!dryRun && decision.content != null) {
        await this.writeHomeFile(localRel, denormalise(decision.content, table))
        await this.writeBase(key, decision.content)
      }
    }

    return { ok: true, dryRun: Boolean(dryRun), actions, conflicts, remote: this.remoteUrl }
  }

  async localFiles() {
    const scanned = await scanAll({ config: this.config, machineId: this.machineId })
    return Object.entries(scanned).flatMap(([k, v]) => v.files.map((f) => ({ slice: k, rel: f.rel, content: f.content })))
  }

  // ------------------------------------------------------------------ restore

  /** Other machines that have a backup directory in the repo. */
  async listMachines() {
    await this.ensureRepo()
    await this.git.fetch(this.remoteBranch).catch(() => ({ ok: false }))
    const out = (await this.git.run(['ls-tree', '--name-only', this.remoteRef, 'instances/'], { allowFail: true })).stdout
    // ls-tree on a directory lists the directory itself; strip the prefix so
    // callers get bare machine ids.
    return out.split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith('instances/') ? s.slice('instances/'.length) : s))
      .filter(Boolean)
  }

  /** Explicitly pull another machine's per-slice backup into this machine. */
  async restoreFromMachine(machine, sliceName, { dryRun = false } = {}) {
    await this.ensureRepo()
    await this.git.fetch(this.remoteBranch).catch(() => ({ ok: false }))
    const prefix = `instances/${machine}/${sliceName}/`
    const keys = await this.remoteKeysUnder(prefix)
    const table = prefixTable()
    const planned = []
    for (const key of keys) {
      const parsed = parseRemoteKey(key)
      if (!parsed) continue
      const rel = localRelFor(parsed.slice, parsed.tag, parsed.relWithin)
      const raw = await this.git.showFile(this.remoteRef, key)
      if (raw == null) continue
      planned.push({ key, rel, bytes: Buffer.byteLength(raw) })
      if (dryRun) continue
      await this.writeHomeFile(rel, denormalise(Buffer.from(raw, 'utf8'), table))
    }
    return { ok: true, machine, slice: sliceName, planned, dryRun: Boolean(dryRun) }
  }

  // ----------------------------------------------------------------------- PR

  async openPr({ title, body } = {}) {
    if (!this.provider.createPr) return { ok: false, reason: '该托管方不支持合并请求' }
    return this.provider.createPr({
      url: this.remoteUrl,
      token: this.token,
      title: title || `sync: ${this.machineId}`,
      body: body || '由 dsh-sync-cnb 提交的共享内容。',
      head: this.pushRef,
      base: this.remoteBranch,
    })
  }

  // ------------------------------------------------------------------- status

  async status() {
    const exists = await this.git.isRepo().catch(() => false)
    const scanned = await scanAll({ config: this.config, machineId: this.machineId })
    const snapshots = await listSnapshots()
    const perSlice = {}
    let blocked = 0
    for (const [k, v] of Object.entries(scanned)) {
      perSlice[k] = {
        files: v.files.length,
        skipped: v.skipped.length,
        strategy: this.config.slices?.[k] || SLICES[k]?.defaultStrategy,
        machineScoped: Boolean(SLICES[k]?.machineScoped),
      }
      blocked += v.blocked.length
    }
    return {
      machineId: this.machineId,
      platform: process.platform,
      provider: this.provider.id,
      remote: this.remoteUrl,
      branch: this.remoteBranch,
      ref: this.pushRef,
      tokenConfigured: Boolean(this.token),
      repoInitialised: exists,
      perSlice,
      blocked,
      snapshots: snapshots.length,
      autoSyncMinutes: this.config.autoSyncMinutes,
      conflictMode: this.config.conflictMode,
    }
  }
}

async function nextConflictName(home, rel) {
  for (let i = 1; i < 1000; i++) {
    const candidate = conflictName(rel, i)
    const taken = await fs.promises.stat(path.join(home, candidate)).then(() => true).catch(() => false)
    if (!taken) return candidate
  }
  return conflictName(rel, Date.now())
}

function counts(scanned) {
  return Object.fromEntries(Object.entries(scanned).map(([k, v]) => [k, v.files.length]))
}

export { BASE_DIR, STATE_FILE, LOCAL_BRANCH }
