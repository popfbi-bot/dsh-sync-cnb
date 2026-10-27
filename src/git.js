// Git child-process wrapper.
//
// Rules enforced here, all of them learned the hard way by earlier plugins:
//  - token never appears in argv (visible to every user via `ps`)
//  - token never appears in stdout/stderr we log or return
//  - MSYS2 path conversion disabled per-process on Windows (see paths.js)
//  - every command runs with `-C <abs repo dir>` so cwd drift cannot happen
//  - `-c credential.helper=` keeps the host's credential store out of it

import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { gitChildEnv, writeAskPass, stateDir, IS_WINDOWS } from './paths.js'

const ASKPASS_DIR = path.join(stateDir(), 'askpass')

export class GitError extends Error {
  constructor(args, code, stderr, stdout) {
    super(`git ${args.join(' ')} failed (${code}): ${redact(stderr)}`)
    this.name = 'GitError'
    this.code = code
    this.stderr = redact(stderr)
    this.stdout = redact(stdout)
    this.args = args
  }
}

/** Strip anything that looks like a token out of git output before it is
 *  logged, returned to the UI, or handed to a model. */
export function redact(text) {
  if (!text) return ''
  return String(text)
    .replace(/[A-Za-z0-9_-]{24,}/g, (m) => (m.length >= 32 ? `${m.slice(0, 4)}***${m.slice(-2)}` : m))
    .replace(/(x-access-token:)[^@\s]+/gi, '$1***')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g, '$1***@')
}

export class Git {
  constructor({ dir, token = '', username = 'cnb', logger } = {}) {
    this.dir = dir
    this.token = token
    this.username = username
    this.logger = logger || (() => {})
    this._askPass = null
  }

  async _ensureAskPass() {
    if (!this.token) return null
    if (this._askPass) return this._askPass
    this._askPass = await writeAskPass(fs, ASKPASS_DIR, this.token, this.username)
    return this._askPass
  }

  /**
   * @param {string[]} args git arguments (without the leading `git`)
   * @param {{ allowFail?: boolean, timeoutMs?: number }} opts
   * @returns {Promise<{ ok: boolean, code: number, stdout: string, stderr: string }>}
   */
  async run(args, opts = {}) {
    const { allowFail = false, timeoutMs = 120_000 } = opts
    const askPass = await this._ensureAskPass()

    const env = gitChildEnv()
    if (askPass) {
      env.GIT_ASKPASS = askPass.file
      Object.assign(env, askPass.env)
    }

    const fullArgs = [
      '-C', this.dir,
      '-c', 'credential.helper=',
      '-c', 'core.autocrlf=false',
      '-c', 'core.quotepath=false',
      ...args,
    ]

    const stdout = await new Promise((resolve, reject) => {
      // shell:false on purpose -- never let a user-supplied path reach a shell.
      const child = spawn('git', fullArgs, { env, shell: false, windowsHide: true })
      let out = ''
      let err = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { child.kill('SIGKILL') } catch {}
        reject(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      child.on('error', (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(e)
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code: code ?? -1, stdout: out, stderr: err })
      })
    })

    const result = {
      ok: stdout.code === 0,
      code: stdout.code,
      stdout: redact(stdout.stdout),
      stderr: redact(stdout.stderr),
    }
    if (!result.ok && !allowFail) throw new GitError(args, result.code, result.stderr, result.stdout)
    return result
  }

  async ok(args, opts) { return (await this.run(args, opts)).ok }
  async out(args, opts) { return (await this.run(args, opts)).stdout.trim() }

  async isRepo() {
    return this.ok(['rev-parse', '--is-inside-work-tree'], { allowFail: true })
  }

  async hasRemote(name = 'origin') {
    return this.ok(['remote', 'get-url', name], { allowFail: true })
  }

  async currentBranch() {
    return this.out(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) || ''
  }

  async statusPorcelain() {
    return (await this.run(['status', '--porcelain', '-uall'], { allowFail: true })).stdout
  }

  async lsFiles() {
    const out = await this.out(['ls-files'], { allowFail: true })
    return out ? out.split('\n').filter(Boolean) : []
  }

  async headSha() {
    return this.out(['rev-parse', 'HEAD'], { allowFail: true }) || ''
  }

  /** Show a file at a ref; returns null when it does not exist there. */
  async showFile(ref, relPath) {
    const r = await this.run(['show', `${ref}:${relPath}`], { allowFail: true })
    return r.ok ? r.stdout : null
  }

  async addAll() { return this.run(['add', '-A']) }

  async commit(message) {
    const r = await this.run(['commit', '-m', message], { allowFail: true })
    if (!r.ok) {
      // "nothing to commit" is not an error for our purposes.
      if (/nothing to commit/i.test(r.stdout + r.stderr)) return { ok: true, noop: true }
      throw new GitError(['commit'], r.code, r.stderr, r.stdout)
    }
    return { ok: true, noop: false }
  }

  async push(branch, { force = false } = {}) {
    const args = ['push', 'origin', `HEAD:${branch}`]
    if (force) args.splice(1, 0, '--force-with-lease')
    return this.run(args, { timeoutMs: 300_000 })
  }

  async fetch(branch) {
    return this.run(['fetch', 'origin', branch], { allowFail: true, timeoutMs: 300_000 })
  }

  async checkoutOrphan(branch) {
    return this.run(['checkout', '--orphan', branch], { allowFail: true })
  }

  async checkout(branch) {
    return this.run(['checkout', branch], { allowFail: true })
  }

  async mergeBase(a, b) {
    return this.out(['merge-base', a, b], { allowFail: true }) || ''
  }

  async init(branch) {
    await fs.promises.mkdir(this.dir, { recursive: true })
    await this.run(['init', '-b', branch])
    return this
  }

  async setRemote(url) {
    const exists = await this.hasRemote('origin')
    await this.run([exists ? 'remote' : 'remote', exists ? 'set-url' : 'add', 'origin', url])
  }

  async ensureIdentity(name = 'dsh-sync-cnb', email = 'dsh-sync-cnb@local') {
    await this.run(['config', 'user.name', name], { allowFail: true })
    await this.run(['config', 'user.email', email], { allowFail: true })
  }

  /**
   * Confirm the working directory git actually resolved to, guarding against a
   * mangled path (Windows) before we do anything destructive.
   */
  async verifyDir() {
    const top = await this.out(['rev-parse', '--show-toplevel'], { allowFail: true })
    if (!top) return { ok: false, reason: 'git could not resolve the repo root' }
    return { ok: true, toplevel: top }
  }
}

export { ASKPASS_DIR, IS_WINDOWS }
