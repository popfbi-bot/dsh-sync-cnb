// Interval scheduler with explicit teardown.
//
// Deliberately not using ctx.jobs: this plugin must also work on hosts that do
// not expose a job service. The interval is registered through ctx.effect so it
// dies with the plugin fiber, and re-registering after a config change replaces
// it rather than stacking duplicates.

const MIN_INTERVAL_MS = 60_000

export class Scheduler {
  constructor({ run, logger, intervalMinutes = 0 }) {
    this.run = run
    this.logger = logger || (() => {})
    this.intervalMinutes = intervalMinutes
    this.timer = null
    this.running = false
    this.lastRunAt = null
    this.lastResult = null
  }

  get enabled() {
    return this.intervalMinutes >= 1
  }

  start() {
    if (!this.enabled || this.timer) return false
    const ms = Math.max(this.intervalMinutes, 1) * MIN_INTERVAL_MS
    this.timer = setInterval(() => { this._tick() }, ms)
    // Do not hold the event loop open just for the scheduler.
    if (typeof this.timer.unref === 'function') this.timer.unref()
    this.logger(`[dsh-sync-cnb] 自动同步已开启，每 ${this.intervalMinutes} 分钟一次`)
    return true
  }

  async _tick() {
    if (this.running) return // never overlap two syncs
    this.running = true
    try {
      const result = await this.run()
      this.lastRunAt = new Date().toISOString()
      this.lastResult = { ok: true, summary: summarize(result) }
    } catch (err) {
      this.lastResult = { ok: false, error: String(err?.message || err) }
      this.logger(`[dsh-sync-cnb] 自动同步失败：${this.lastResult.error}`)
    } finally {
      this.running = false
    }
  }

  stop() {
    if (!this.timer) return false
    clearInterval(this.timer)
    this.timer = null
    return true
  }

  /** Called on config change: adjust the interval without leaking timers. */
  reconfigure(intervalMinutes) {
    const next = Number(intervalMinutes) || 0
    if (next === this.intervalMinutes && this.timer) return false
    this.stop()
    this.intervalMinutes = next
    return this.start()
  }

  snapshot() {
    return {
      enabled: this.enabled,
      intervalMinutes: this.intervalMinutes,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      running: this.running,
    }
  }
}

function summarize(result) {
  if (!result) return null
  return {
    pushed: result.pushed ?? null,
    files: result.files ?? null,
    actions: Array.isArray(result.actions) ? result.actions.length : null,
    conflicts: Array.isArray(result.conflicts) ? result.conflicts.length : null,
  }
}
