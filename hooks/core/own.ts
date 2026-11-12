import type { EngineInterface } from 'claude-code'

import { canonical, fold } from '../review/diff'

// What this session wrote in its turn, so a file another session wrote in the same folder meanwhile
// (two terminals in one project) is not taken for this one's and sent back to its Claude. A file an
// edit tool wrote, or a shell command left uncommitted where it was not, is this session's; one that
// changed by itself is, only where its time of change falls while a shell command of this session
// ran. Each session knows only its own: no state is shared between them.

// A file's time of change may lag the clock or be rounded (a second or two on some disks).
const SLACK_MS = 2_000

type Window = { from: number; to: number | null }
export type Own = { readonly isTracked: boolean; readonly edited: ReadonlySet<string>; readonly windows: readonly Window[] }

// Untracked till a main turn's start is seen (a reload under one): all is taken as the session's.
let isTracked = false
let edited = new Set<string>()
let windows: Window[] = []

// One spelling of a path, as `samePath` compares them.
const keyOf = (path: string) => fold(canonical(path))

// A main turn started: what the last one wrote is no longer this one's.
export function startOwn() {
  isTracked = true
  edited = new Set()
  windows = []
}

export function markEdit(path: string) {
  edited.add(keyOf(path))
}

// A shell command of this session started: resolves to its end, to call once it ran. One left to run
// in the background has no end: what changes until the turn's is taken as its.
export function markShell(from: number, isBackground: boolean) {
  const window: Window = { from, to: null }
  windows.push(window)
  return (to: number) => {
    if (!isBackground) window.to = to
  }
}

// The turn's, taken as it ends before anything is awaited: the next turn may start meanwhile.
export const takeOwn = (): Own => ({ isTracked, edited: new Set(edited), windows: windows.map(w => ({ ...w })) })

// Whether `path`, which changed, is the session's own by `own`. A file whose time is not known is
// taken as its own, as before.
export async function isOwn($: EngineInterface, own: Own, path: string) {
  if (!own.isTracked || own.edited.has(keyOf(path))) return true
  const at = await $.fs
    .stat(path)
    .then(s => s.mtimeMs)
    .catch(() => undefined)
  if (at === undefined || !Number.isFinite(at)) return true
  return own.windows.some(w => at >= w.from - SLACK_MS && (w.to === null || at <= w.to + SLACK_MS))
}

// The paths of `paths` that are the session's own.
export async function ownOf($: EngineInterface, own: Own, paths: readonly string[]) {
  const kept: string[] = []
  for (const path of paths) if (await isOwn($, own, path)) kept.push(path)
  return kept
}
