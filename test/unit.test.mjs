import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SRC = new URL('../src/', import.meta.url).pathname
const { normalizeConfig } = await import(`${SRC}config.js`)
const { getProvider, providers } = await import(`${SRC}providers/index.js`)
const { neutralise, denormalise, prefixTable, TOKENS } = await import(`${SRC}transform.js`)
const { isExcluded, parseRemoteKey, remoteKey, localRelFor, classifyRoot, SLICES } = await import(`${SRC}slices.js`)
const { scanBuffer, gate } = await import(`${SRC}secrets.js`)
const { threeWay, conflictName } = await import(`${SRC}merge.js`)
const { redact } = await import(`${SRC}git.js`)
const { machineLabel, toPosix } = await import(`${SRC}paths.js`)

test('config: defaults and clamping', () => {
  const c = normalizeConfig({})
  assert.equal(c.provider, 'cnb')
  assert.equal(c.branch, 'main')
  assert.equal(c.slices.skills, 'union')
  assert.equal(c.slices.sessions, 'backup')
  assert.equal(c.conflictMode, 'manual')
  assert.equal(c.autoSyncMinutes, 0)

  const bad = normalizeConfig({ conflictMode: 'nope', slices: { skills: 'bogus' }, autoSyncMinutes: 0.5 })
  assert.equal(bad.conflictMode, 'manual')
  assert.equal(bad.slices.skills, 'union')
  assert.equal(bad.autoSyncMinutes, 0)
})

test('config: unknown slice strategy falls back to the slice default', () => {
  const c = normalizeConfig({ slices: { sessions: 'remote' } })
  assert.equal(c.slices.sessions, 'remote')
})

test('providers: detect from url', () => {
  assert.equal(getProvider('https://cnb.cool/me/dsh-sync').id, 'cnb')
  assert.equal(getProvider('https://github.com/me/dsh-sync').id, 'github')
  assert.equal(getProvider('https://gitee.com/me/dsh-sync').id, 'gitee')
  assert.equal(getProvider('https://git.example.com/me/repo').id, 'selfhost')
  assert.equal(getProvider('cnb').id, 'cnb')
})

test('providers: cnb url shapes', () => {
  const cnb = providers.cnb
  assert.equal(cnb.normalizeUrl('me/repo'), 'https://cnb.cool/me/repo')
  assert.equal(cnb.normalizeUrl('cnb.cool/me/repo'), 'https://cnb.cool/me/repo')
  assert.equal(cnb.normalizeUrl('https://cnb.cool/me/repo.git'), 'https://cnb.cool/me/repo')
  assert.equal(cnb.repoPath('https://cnb.cool/me/repo'), 'me/repo')
  assert.equal(cnb.gitUsername, 'cnb')
})

test('providers: github url shapes', () => {
  const gh = providers.github
  assert.equal(gh.normalizeUrl('me/repo'), 'https://github.com/me/repo')
  assert.equal(gh.repoPath('https://github.com/me/repo'), 'me/repo')
  assert.equal(gh.gitUsername, 'x-access-token')
})

test('providers: self-hosted cannot be verified as private', async () => {
  const p = getProvider('https://git.example.com/me/repo')
  const res = await p.verifyPrivate('https://git.example.com/me/repo', 'tok')
  assert.equal(res.unverified, true)
  assert.equal(res.private, null)
})

test('transform: absolute paths round-trip through tokens', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'))
  process.env.DSH_HOME = home
  const table = prefixTable()
  const original = `workspace at ${home}/proj\n`
  const out = neutralise(Buffer.from(original), table).toString()
  assert.ok(!out.includes(home), 'absolute home path must not survive')
  assert.ok(out.includes(TOKENS.DSH_HOME))
  const back = denormalise(Buffer.from(out), table).toString()
  assert.equal(back, original)
})

test('transform: binary buffers are left alone', () => {
  const buf = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00])
  const table = prefixTable()
  assert.equal(neutralise(buf, table), buf)
})

test('exclusions: the things that break a cross-platform copy', () => {
  assert.equal(isExcluded('.credentials.yaml'), true)
  assert.equal(isExcluded('profiles/web/package.json'), true)
  assert.equal(isExcluded('node_modules/foo/index.js'), true)
  assert.equal(isExcluded('sessions/abc/session.lock'), true)
  assert.equal(isExcluded('storages/x'), true)
  assert.equal(isExcluded('workspace.json'), true)
  assert.equal(isExcluded('sessions/abc/log.jsonl'), false)
  assert.equal(isExcluded('skills/foo/SKILL.md'), false)
  // user-supplied excludes stack on top of the hard ones
  assert.equal(isExcluded('skills/secret/KEY.md', ['skills/secret/']), true)
})

test('keys: machine-scoped vs shared namespaces', () => {
  assert.equal(
    remoteKey('sessions', { tag: 'log', relWithin: 'a/b.jsonl' }, 'mac-1'),
    'instances/mac-1/sessions/log/a/b.jsonl',
  )
  assert.equal(
    remoteKey('skills', { tag: 'skills', relWithin: 'foo/SKILL.md' }, 'mac-1'),
    'shared/skills/skills/foo/SKILL.md',
  )
  assert.deepEqual(parseRemoteKey('instances/mac-1/sessions/log/a/b.jsonl'), {
    scope: 'instances', machine: 'mac-1', slice: 'sessions', tag: 'log', relWithin: 'a/b.jsonl',
  })
  assert.deepEqual(parseRemoteKey('shared/skills/skills/foo/SKILL.md'), {
    scope: 'shared', slice: 'skills', tag: 'skills', relWithin: 'foo/SKILL.md',
  })
  // round-trip: key -> local path
  assert.equal(classifyRoot('sessions', 'sessions/a/b.jsonl').tag, 'log')
  assert.equal(classifyRoot('sessions', 'sessions/a/b.jsonl').relWithin, 'a/b.jsonl')
  assert.equal(localRelFor('sessions', 'log', 'a/b.jsonl'), 'sessions/a/b.jsonl')
  assert.equal(localRelFor('settings', 'root', 'settings.yaml'), 'settings.yaml')
  assert.equal(classifyRoot('skills', '.agents/skills/x/SKILL.md').tag, 'dot')
  assert.equal(localRelFor('skills', 'dot', 'x/SKILL.md'), '.agents/skills/x/SKILL.md')
})

test('secrets: a pasted key blocks the upload', () => {
  // 用全 x 占位：够长能触发 SECRET_HINTS 的 /sk-[A-Za-z0-9]{20,}/，
  // 又不像真 key，免得被 GitHub push protection 当成 DeepSeek API Key 拦下。
  const findings = scanBuffer(Buffer.from('DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx'), 'sessions/x.jsonl')
  assert.ok(findings.length >= 1)
  const verdict = gate('sessions/x.jsonl', findings)
  assert.equal(verdict.allow, false)
  assert.match(verdict.reason, /疑似包含密钥/)
  // explicit override still works
  assert.equal(gate('sessions/x.jsonl', findings, { allowSensitive: true }).allow, true)
})

test('merge: three-way decisions', () => {
  const A = Buffer.from('a')
  const B = Buffer.from('b')
  assert.equal(threeWay({ base: A, ours: A, theirs: B }).action, 'take-remote')
  assert.equal(threeWay({ base: A, ours: B, theirs: A }).action, 'take-local')
  assert.equal(threeWay({ base: A, ours: A, theirs: A }).action, 'identical')
  assert.equal(threeWay({ base: null, ours: A, theirs: null }).action, 'add-local')
  assert.equal(threeWay({ base: null, ours: null, theirs: B }).action, 'add-remote')
  assert.equal(threeWay({ base: A, ours: B, theirs: Buffer.from('c') }).conflict, true)
  // overrides short-circuit all merge reasoning
  assert.equal(threeWay({ base: A, ours: A, theirs: B, strategy: 'local' }).action, 'take-local')
  assert.equal(threeWay({ base: A, ours: A, theirs: B, strategy: 'remote' }).action, 'take-remote')
  // conflictMode resolves an otherwise conflicting case
  assert.equal(threeWay({ base: A, ours: B, theirs: Buffer.from('c'), conflictMode: 'keep-remote' }).action, 'take-remote')
  assert.equal(threeWay({ base: A, ours: B, theirs: Buffer.from('c'), conflictMode: 'keep-local' }).action, 'take-local')
})

test('merge: conflict copies never collide', () => {
  assert.equal(conflictName('skills/a/SKILL.md', 1), 'skills/a/SKILL.conflict1.md')
  assert.equal(conflictName('settings.yaml', 2), 'settings.conflict2.yaml')
})

test('git: output is redacted before it can leak', () => {
  const s = 'remote: https://cnb:1Z00000000000000000000000vA@cnb.cool/me/repo.git'
  assert.ok(!redact(s).includes('1Z00000000000000000000000vA'))
})

test('paths: machine label is safe for a git branch name', () => {
  const label = machineLabel('Alice/Win 11')
  assert.equal(label, 'Alice-Win 11')
  assert.ok(!label.includes('/'))
  assert.ok(!label.includes('\\'))
})

test('slices: every slice declares a default strategy', () => {
  for (const [name, s] of Object.entries(SLICES)) {
    assert.ok(s.defaultStrategy, `${name} has no default strategy`)
    assert.equal(typeof s.machineScoped, 'boolean')
  }
})
