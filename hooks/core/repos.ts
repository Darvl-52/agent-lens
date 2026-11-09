import type { EngineInterface } from 'claude-code'

import { type Aliases, aliasesOf } from '../lenses/report'
import { canonical, joinPath } from '../review/diff'

// So many of the project's top folders looked in for a repository of their own, at most.
const NESTED_LIMIT = 40
// What was found is kept for the turn, and no longer than this, where no turn starts to drop it.
const NESTED_KEPT_MS = 60_000

// What was found, by the project folder, and when.
const found = new Map<string, { at: number; repos: Promise<string[]> }>()

// Every repository of its own in a top folder of the project, as dev-env keeps its clones
// (`__front`, ignored by its own repository): the shell may edit one no tool did, and a branch of
// the work lives there as much as in the project's own. Looked for once a turn, and again in the
// next (`forgetNestedRepos`), so a clone made since is found.
export async function nestedRepos($: EngineInterface, root: string) {
  const now = await $.clock.now()
  const kept = found.get(root)
  if (kept && now - kept.at >= 0 && now - kept.at < NESTED_KEPT_MS) return kept.repos
  const repos = look($, root)
  found.set(root, { at: now, repos })
  repos.catch(() => found.delete(root))
  return repos
}

async function look($: EngineInterface, root: string) {
  const dirs = (await $.fs.list(root).catch(() => [])).filter(x => x.kind === 'dir' && !x.name.startsWith('.')).slice(0, NESTED_LIMIT)
  const at = await Promise.all(dirs.map(async d => ((await $.fs.exists(joinPath(root, `${d.name}/.git`)).catch(() => false)) ? joinPath(root, d.name) : null)))
  return at.filter((d): d is string => d !== null).map(d => canonical(d))
}

// A turn starts: the clones are looked for again.
export function forgetNestedRepos() {
  found.clear()
}

// git's aliases in the project, by its folder: read once a session, so a command that names git
// spawns no `git config` of its own each time.
const aliases = new Map<string, Promise<Aliases>>()
export function gitAliases($: EngineInterface, root: string) {
  let held = aliases.get(root)
  if (!held) {
    held = $.process
      .run(['git', '-C', root, 'config', '--get-regexp', '^alias\\.'], { cwd: root, timeoutMs: 15_000 })
      .then(r => aliasesOf(r.exitCode === 0 ? r.stdout.trim() : ''))
    aliases.set(root, held)
    // A read that failed is no answer: the next asks again.
    held.catch(() => aliases.delete(root))
  }
  return held.catch(() => ({}) as Aliases)
}

// Another session or conversation: everything is read again.
export function forgetRepos() {
  found.clear()
  aliases.clear()
}
