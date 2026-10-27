// Plugin configuration + normalization.
//
// The exported `Config` is a Schemastery schema when the host provides it;
// `normalizeConfig` is the runtime fallback that always runs, so behaviour is
// identical whether or not schema validation is available.

const STRATEGIES = ['backup', 'union', 'remote', 'local']
const SLICE_NAMES = ['skills', 'sessions', 'settings', 'plugins']
const CONFLICT_MODES = ['manual', 'keep-local', 'keep-remote', 'ai']

/** Default strategy per slice. See README "策略语义". */
const DEFAULT_STRATEGY = {
  skills: 'union',
  sessions: 'backup',
  settings: 'backup',
  plugins: 'backup',
}

/** Default on/off per slice. Sessions default ON here because this plugin is
 *  aimed at "several machines in parallel use"; turn it off per machine if you
 *  only want skills + settings to travel. */
const DEFAULT_ENABLED = {
  skills: true,
  sessions: true,
  settings: true,
  plugins: true,
}

export function normalizeConfig(raw = {}) {
  const cfg = raw && typeof raw === 'object' ? raw : {}

  const slices = {}
  for (const name of SLICE_NAMES) {
    const declared = cfg.slices?.[name] ?? DEFAULT_STRATEGY[name]
    slices[name] = STRATEGIES.includes(declared) ? declared : DEFAULT_STRATEGY[name]
  }

  const enabled = {}
  for (const name of SLICE_NAMES) {
    enabled[name] = cfg.enabled?.[name] === undefined
      ? DEFAULT_ENABLED[name]
      : Boolean(cfg.enabled[name])
  }

  const minutes = Number(cfg.autoSyncMinutes)
  const conflictMode = CONFLICT_MODES.includes(cfg.conflictMode) ? cfg.conflictMode : 'manual'
  const retention = Number.isFinite(Number(cfg.snapshotRetention))
    ? Math.min(Math.max(Number(cfg.snapshotRetention), 1), 365)
    : 30

  return {
    provider: typeof cfg.provider === 'string' && cfg.provider ? cfg.provider : 'cnb',
    repoUrl: typeof cfg.repoUrl === 'string' ? cfg.repoUrl.trim() : '',
    branch: typeof cfg.branch === 'string' && cfg.branch ? cfg.branch : 'main',
    // Empty machineId is resolved lazily to hostname@platform in machine.js.
    machineId: typeof cfg.machineId === 'string' ? cfg.machineId.trim() : '',
    slices,
    enabled,
    // 0 disables the scheduler. Hard floor of 1 minute to avoid hammering.
    autoSyncMinutes: Number.isFinite(minutes) && minutes >= 1 ? minutes : 0,
    conflictMode,
    snapshotRetention: retention,
    uploadSnapshotsToRemote: Boolean(cfg.uploadSnapshotsToRemote),
    // false: push straight to the shared branch. true: push to dsh/<machine>
    // and open a PR, so the shared part can be reviewed before it lands.
    prMode: Boolean(cfg.prMode),
    exclude: Array.isArray(cfg.exclude) ? cfg.exclude.filter((x) => typeof x === 'string') : [],
  }
}

/**
 * Config read from process.env / settings file wins over the patch default.
 * Token is deliberately NOT part of Config: it lives in .credentials.yaml or
 * an env var and is write-only (see credentials.js).
 */
export function resolveSecret(config) {
  return (
    process.env.DSH_SYNC_TOKEN ||
    process.env.CNB_TOKEN ||
    process.env.GITHUB_TOKEN ||
    ''
  )
}

// 不导出 Config：DSH 的 settings/describe 会遍历插件的配置 schema，
// 没有 schemastery 时导出 null 会让 describe 返回 ok=false，宿主直接起不来。
// 同目录的 story-os / dsh-quant 都不导出 Config，运行时统一用 normalizeConfig。

export { STRATEGIES, SLICE_NAMES, CONFLICT_MODES, DEFAULT_STRATEGY, DEFAULT_ENABLED }
