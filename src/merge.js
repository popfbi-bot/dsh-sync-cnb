// Three-way merge and conflict policy.
//
// A two-way diff ("local is newer, overwrite remote") is what loses data. We
// keep a base copy of what the remote looked like at the last successful sync,
// which makes the decision mechanical:
//
//   ours unchanged  -> take theirs   (someone else edited)
//   theirs unchanged-> take ours     (only we edited)
//   both changed    -> keep ours locally, park theirs as <file>.conflictN
//
// Nothing is ever silently overwritten. Conflicts are reported, not resolved
// behind the user's back.

import { shortId } from './paths.js'

function eq(a, b) {
  if (a == null || b == null) return a == null && b == null
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b)
  return String(a) === String(b)
}

/**
 * @param {{ base?: Buffer|null, ours?: Buffer|null, theirs?: Buffer|null,
 *           strategy?: string, conflictMode?: string, rel?: string }} input
 * @returns {{ content: Buffer|null, action: string, conflict: boolean }}
 */
export function threeWay({
  base = null,
  ours = null,
  theirs = null,
  strategy = 'union',
  conflictMode = 'manual',
  rel = '',
} = {}) {
  // remote-wins / local-wins are pure overrides; no merge reasoning at all.
  if (strategy === 'remote') return { content: theirs, action: 'take-remote', conflict: false }
  if (strategy === 'local') return { content: ours, action: 'take-local', conflict: false }

  if (ours == null && theirs != null) return { content: theirs, action: 'add-remote', conflict: false }
  if (theirs == null && ours != null) return { content: ours, action: 'add-local', conflict: false }
  if (ours == null && theirs == null) return { content: null, action: 'noop', conflict: false }

  if (eq(ours, theirs)) return { content: ours, action: 'identical', conflict: false }

  const baseKnown = base != null
  if (!baseKnown) {
    // First contact: no shared ancestor. Treat as a conflict rather than
    // guessing which side is authoritative.
    if (conflictMode === 'keep-remote') return { content: theirs, action: 'take-remote', conflict: false }
    return { content: ours, action: 'conflict-no-base', conflict: true }
  }

  const oursChanged = !eq(ours, base)
  const theirsChanged = !eq(theirs, base)

  if (!oursChanged && theirsChanged) return { content: theirs, action: 'take-remote', conflict: false }
  if (oursChanged && !theirsChanged) return { content: ours, action: 'take-local', conflict: false }
  if (!oursChanged && !theirsChanged) return { content: ours, action: 'identical', conflict: false }

  // Both changed, differently.
  if (conflictMode === 'keep-remote') return { content: theirs, action: 'take-remote', conflict: false }
  if (conflictMode === 'keep-local') return { content: ours, action: 'take-local', conflict: false }
  // 'ai' is deliberately NOT implemented as an automatic call: handing
  // settings.yaml to a model means handing it whatever secrets that file holds.
  // Reserved hook -- see README.
  return { content: ours, action: 'conflict', conflict: true }
}

export function conflictName(rel, n = 1) {
  const dot = rel.lastIndexOf('.')
  const base = dot > 0 ? rel.slice(0, dot) : rel
  const ext = dot > 0 ? rel.slice(dot) : ''
  return `${base}.conflict${n}${ext}`
}

export function makeConflictId() {
  return shortId(3)
}
