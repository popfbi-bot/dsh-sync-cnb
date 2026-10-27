// End-to-end: two "machines" syncing through a real local bare repo.
// No network, no provider -- this exercises the engine, the exclusions, the
// three-way merge and the cross-platform path transform.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const SRC = new URL('../src/', import.meta.url).pathname
const { normalizeConfig } = await import(`${SRC}config.js`)
const { SyncEngine } = await import(`${SRC}sync.js`)
const { readFile } = fs.promises

let ROOT
let BARE

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function makeHome(machine) {
  const home = path.join(ROOT, machine, '.dsh')
  fs.mkdirSync(path.join(home, 'sessions', 's1'), { recursive: true })
  fs.mkdirSync(path.join(home, 'skills', 'shared-skill'), { recursive: true })
  fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true })
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true })
  fs.mkdirSync(path.join(home, 'node_modules', 'junk'), { recursive: true })

  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'apiKey: sk-SHOULD-NEVER-LEAVE\n')
  fs.writeFileSync(path.join(home, 'settings.yaml'), `workspaceRoot: ${home}/projects\ntheme: dark\n`)
  fs.writeFileSync(path.join(home, 'sessions', 's1', 'log.jsonl'), `{"cwd":"${home}/projects"}\n`)
  fs.writeFileSync(path.join(home, 'skills', 'shared-skill', 'SKILL.md'), `# shared skill\nbase\n`)
  fs.writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), '{"name":"web"}\n')
  fs.writeFileSync(path.join(home, 'storages', 'blob.bin'), Buffer.from([0, 1, 2]))
  fs.writeFileSync(path.join(home, 'node_modules', 'junk', 'index.js'), 'console.log(1)\n')
  fs.writeFileSync(path.join(home, 'workspace.json'), '{"workspaces":[]}\n')
  fs.writeFileSync(path.join(home, 'sessions', 's1', 'session.lock'), 'locked\n')
  return home
}

/** Build an engine bound to a given machine home. */
async function engineFor(machine, overrides = {}) {
  const home = path.join(ROOT, machine, '.dsh')
  process.env.DSH_HOME = home
  const config = normalizeConfig({
    provider: 'selfhost',
    repoUrl: BARE,
    branch: 'main',
    machineId: machine,
    ...overrides,
  })
  return new SyncEngine({ config, token: '', logger: () => {} })
}

before(async () => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-e2e-'))
  BARE = path.join(ROOT, 'remote.git')
  fs.mkdirSync(BARE)
  git(['init', '--bare', '-b', 'main', '.'], BARE)
  makeHome('A')
  makeHome('B')
})

after(() => {
  if (ROOT) fs.rmSync(ROOT, { recursive: true, force: true })
})

test('machine A: first sync pushes only what is allowed to travel', async () => {
  const engine = await engineFor('A')
  const r = await engine.sync()
  assert.equal(r.ok, true)
  assert.equal(r.pushed, true)

  const files = git(['ls-tree', '-r', '--name-only', 'main'], BARE).trim().split('\n').filter(Boolean)

  // present
  assert.ok(files.includes('shared/skills/skills/shared-skill/SKILL.md'), 'shared skill must travel')
  assert.ok(files.includes('instances/A/sessions/log/s1/log.jsonl'), 'A sessions must travel')
  assert.ok(files.includes('instances/A/settings/root/settings.yaml'), 'A settings must travel')
  assert.ok(files.includes('instances/A/plugins/root/profiles/web/package.json'), 'plugin manifest must travel')

  // absent -- the whole point of the exclusion list
  for (const forbidden of [
    '.credentials.yaml',
    'storages/blob.bin',
    'workspace.json',
    'session.lock',
  ]) {
    assert.ok(!files.some((f) => f.endsWith(forbidden)), `${forbidden} must never be uploaded`)
  }
  assert.ok(!files.some((f) => f.includes('node_modules')), 'node_modules must never be uploaded')
  // profiles/ is excluded except the manifest
  assert.ok(!files.some((f) => f.startsWith('shared/') && f.includes('profiles/')))
})

test('machine A: uploaded content carries no machine-specific path', async () => {
  const raw = git(['show', 'main:instances/A/settings/root/settings.yaml'], BARE)
  const homeA = path.join(ROOT, 'A', '.dsh')
  assert.ok(!raw.includes(homeA), 'settings.yaml must not contain A home path')
  assert.ok(raw.includes('{{DSH_HOME}}'), 'path should be neutralised to a token')
})

test('machine B: pull gets shared content but never A private state', async () => {
  const b = await engineFor('B')
  const r = await b.pull({})
  assert.equal(r.ok, true)

  const bHome = path.join(ROOT, 'B', '.dsh')
  const skill = await readFile(path.join(bHome, 'skills', 'shared-skill', 'SKILL.md'), 'utf8')
  assert.match(skill, /shared skill/)

  // B's own settings must be untouched by A's backup.
  const settings = await readFile(path.join(bHome, 'settings.yaml'), 'utf8')
  const norm = (s) => s.replace(/\\/g, '/')
  assert.ok(norm(settings).includes(norm(path.join(bHome, 'projects'))), 'B settings must still point at B')
})

test('machine B: sync creates its own namespace without touching A', async () => {
  const b = await engineFor('B')
  await b.sync()
  const files = git(['ls-tree', '-r', '--name-only', 'main'], BARE).trim().split('\n')
  assert.ok(files.includes('instances/B/sessions/log/s1/log.jsonl'))
  assert.ok(files.includes('instances/A/sessions/log/s1/log.jsonl'), 'A state must survive B push')
})

test('union: a skill added on B reaches A', async () => {
  const bHome = path.join(ROOT, 'B', '.dsh')
  fs.mkdirSync(path.join(bHome, 'skills', 'from-b'), { recursive: true })
  fs.writeFileSync(path.join(bHome, 'skills', 'from-b', 'SKILL.md'), '# from B\n')
  const b = await engineFor('B')
  await b.sync()

  const a = await engineFor('A')
  await a.pull({})
  const aSkill = await readFile(path.join(ROOT, 'A', '.dsh', 'skills', 'from-b', 'SKILL.md'), 'utf8')
  assert.match(aSkill, /from B/)
})

test('conflict: both machines edit the same skill -> local kept, remote parked', async () => {
  const aHome = path.join(ROOT, 'A', '.dsh')
  const bHome = path.join(ROOT, 'B', '.dsh')

  const a = await engineFor('A')
  await a.pull({}) // adopt base
  fs.writeFileSync(path.join(aHome, 'skills', 'shared-skill', 'SKILL.md'), '# edited by A\n')
  await (await engineFor('A')).sync()

  fs.writeFileSync(path.join(bHome, 'skills', 'shared-skill', 'SKILL.md'), '# edited by B\n')
  const b = await engineFor('B', { conflictMode: 'manual' })
  const r = await b.sync()

  assert.equal(r.ok, true)
  const local = await readFile(path.join(bHome, 'skills', 'shared-skill', 'SKILL.md'), 'utf8')
  assert.match(local, /edited by B/, 'local version must win')
  const conflictFile = await readFile(path.join(bHome, 'skills', 'shared-skill', 'SKILL.conflict1.md'), 'utf8')
  assert.match(conflictFile, /edited by A/, 'remote version must be preserved')
  assert.ok(r.conflicts.length >= 1)
})

test('restore: A sessions restored onto B get B paths, not A paths', async () => {
  const a = await engineFor('A')
  await a.sync()
  const b = await engineFor('B')
  const r = await b.restoreFromMachine('A', 'sessions')
  assert.ok(r.planned.length >= 1)

  const bHome = path.join(ROOT, 'B', '.dsh')
  const restored = await readFile(path.join(bHome, 'sessions', 's1', 'log.jsonl'), 'utf8')
  const norm = (s) => s.replace(/\\/g, '/')
  assert.ok(!norm(restored).includes(norm(path.join(ROOT, 'A', '.dsh'))), 'restored log must not reference A home')
  assert.ok(norm(restored).includes(norm(path.join(bHome, 'projects'))), 'restored log must be rewritten to B home')
})

test('machines: both instances are discoverable', async () => {
  const b = await engineFor('B')
  const machines = await b.listMachines()
  assert.deepEqual(machines.sort(), ['A', 'B'])
})

test('secrets: a key pasted into a session blocks that file only', async () => {
  const aHome = path.join(ROOT, 'A', '.dsh')
  fs.writeFileSync(path.join(aHome, 'sessions', 's1', 'leaky.jsonl'), '{"note":"key is sk-xxxxxxxxxxxxxxxxxxxxxxxx"}\n')
  const engine = await engineFor('A')
  const r = await engine.sync()
  assert.ok(r.blocked.some((b) => b.rel.includes('leaky.jsonl')), 'leaky file must be blocked')
  const files = git(['ls-tree', '-r', '--name-only', 'main'], BARE)
  assert.ok(!files.includes('instances/A/sessions/s1/leaky.jsonl'), 'leaky file must not be committed')
})

test('snapshots: pre-pull snapshot exists and is restorable', async () => {
  const { listSnapshots, readSnapshotManifest } = await import(`${SRC}snapshot.js`)
  const b = await engineFor('B')
  await b.pull({ snapshot: true })
  const all = await listSnapshots()
  assert.ok(all.length >= 1, 'at least one snapshot should exist')
  const manifest = await readSnapshotManifest(all[0].name)
  assert.ok(manifest.files.length >= 1)
  assert.ok(manifest.files.every((f) => !f.rel.startsWith('/')), 'snapshot paths must be relative')
})
