import type { EngineInterface } from 'claude-code'

import { canonical, joinPath } from '../review/diff'

// So many of the project's top folders looked in for a repository of their own, at most.
const NESTED_LIMIT = 40

// Every repository of its own in a top folder of the project, as dev-env keeps its clones
// (`__front`, ignored by its own repository): the shell may edit one no tool did, and a branch of
// the work lives there as much as in the project's own. Looked for again each time, so a clone made
// since is found.
export async function nestedRepos($: EngineInterface, root: string) {
  const dirs = (await $.fs.list(root).catch(() => [])).filter(x => x.kind === 'dir' && !x.name.startsWith('.')).slice(0, NESTED_LIMIT)
  const found = await Promise.all(dirs.map(async d => ((await $.fs.exists(joinPath(root, `${d.name}/.git`)).catch(() => false)) ? joinPath(root, d.name) : null)))
  return found.filter((d): d is string => d !== null).map(canonical)
}
