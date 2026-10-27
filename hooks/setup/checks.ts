import type { Baseline, Checks, DocIssue, GateFailure, RunCommands } from '../../types/setup'

// The project's checks and how it is brought up, as `.claude/agent-lens.json` keeps them: commands
// of the project's own, whatever its stack, which Claude reads from the project and the person
// confirms. No manifest is parsed here: a command is a line for the shell, run where it says.
// Nothing here reaches the engine, so the CLI runs the same checks in CI.

export const CONFIG = '.claude/agent-lens.json'
export const SETTINGS = '.claude/settings.json'
// The place of the changed files in a fast command, for runners that take files; `{files:py,pyi}`
// takes only those of these extensions, as a tool given a file it does not read fails on it.
const FILES = /\{files(?::([\w.,\s]+))?\}/g
// A fast command past this is too slow to run at every turn's end: it belongs to the full tier.
const FAST_BUDGET_MS = 120_000
// How long one command of a tier may run, and how much of what it wrote goes back to Claude.
const COMMAND_TIMEOUT_MS = 300_000
const OUTPUT_LINES = 60
const OUTPUT_CHARS = 4_000
// The untracked files hashed for the tree's fingerprint, at most: past them, their names alone.
const HASHED = 200
// The folder a list of commands with no folder runs in: the root.
const ROOT = '.'

export type Config = { checks?: Checks; run?: RunCommands }
export type Exec = (argv: readonly string[], cwd: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>
// One command run: where, what, how long, how it ended.
export type Timing = { folder: string; command: string; ms: number; exitCode: number }

const isCommands = (v: unknown): v is string[] => Array.isArray(v) && v.every(c => typeof c === 'string' && c.trim() !== '')
const isFolder = (f: string) => f !== '' && !f.startsWith('/') && !/^[a-z]:/i.test(f) && !f.split(/[\\/]/).includes('..')
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// A command as the person reads it: by its folder where it is not the root's.
export const whereOf = (f: { folder: string; command: string }) => (f.folder === ROOT ? f.command : `${f.folder}: ${f.command}`)

// A tier as written: a list for the root, or lists by the folder each runs in (a monorepo).
function tierOf(v: unknown): Record<string, string[]> | string {
  if (isCommands(v)) return { [ROOT]: v }
  if (!isObject(v)) return 'a list of commands, or lists by folder'
  const out: Record<string, string[]> = {}
  for (const [folder, list] of Object.entries(v)) {
    if (!isFolder(folder)) return `the folder "${folder}" is not one of the project's`
    if (!isCommands(list)) return `the commands of "${folder}" are not a list of commands`
    const key = folder.replace(/^\.\//, '').replace(/\/$/, '') || ROOT
    if (key in out) return `the folder "${key}" is named twice`
    out[key] = list
  }
  return out
}

// The file read, or what is wrong with its form: one issue each, on the file. A key it does not know
// is an issue too, as a misspelt tier would leave the gate with nothing to run and say nothing.
export function parseConfig(text: string): { config: Config; issues: DocIssue[] } {
  const issue = (detail: string): DocIssue => ({ file: CONFIG, kind: 'checks-shape', detail })
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { config: {}, issues: [issue('not JSON')] }
  }
  if (!isObject(raw)) return { config: {}, issues: [issue('not a JSON object')] }
  const config: Config = {}
  const issues: DocIssue[] = []
  if (raw.checks !== undefined) {
    const c = raw.checks
    if (!isObject(c) || Object.keys(c).some(k => k !== 'fast' && k !== 'full')) issues.push(issue('checks: an object of fast and full'))
    else {
      const fast = c.fast === undefined ? {} : tierOf(c.fast)
      const full = c.full === undefined ? {} : tierOf(c.full)
      if (typeof fast === 'string') issues.push(issue(`checks.fast: ${fast}`))
      if (typeof full === 'string') issues.push(issue(`checks.full: ${full}`))
      if (typeof fast !== 'string' && typeof full !== 'string') config.checks = { fast, full }
    }
  }
  if (raw.run !== undefined) {
    const r = raw.run
    if (r === null) config.run = null
    else if (!isObject(r) || Object.keys(r).length === 0 || Object.entries(r).some(([k, v]) => !['up', 'smoke', 'down'].includes(k) || typeof v !== 'string'))
      issues.push(issue('run: null, or up, smoke and down, each a command'))
    else config.run = r as RunCommands
  }
  return { config, issues }
}

// Whether a command takes the changed files.
const takesFiles = (command: string) => new RegExp(FILES.source).test(command)

// A command with the files put in their place, those of its extensions where it names some, quoted
// for the shell it goes to; none where it takes files and there are none for it, as a runner given
// no files may run every test there is.
export function expand(command: string, files: readonly string[], shell: Shell) {
  let isEmpty = false
  const line = command.replace(FILES, (_, exts: string | undefined) => {
    const wanted = exts?.split(/[\s,]+/).filter(Boolean).map(e => `.${e.replace(/^\./, '')}`)
    const taken = wanted ? files.filter(f => wanted.some(e => f.endsWith(e))) : files
    if (taken.length === 0) isEmpty = true
    return taken.map(f => (shell === 'sh' ? `'${f.replace(/'/g, `'\\''`)}'` : `"${f.replace(/"/g, '""')}"`)).join(' ')
  })
  return isEmpty ? null : line
}

// `sh` where there is one, Windows' `cmd` elsewhere: commands are the project's own lines, written
// for the shell its people use.
export type Shell = 'sh' | 'cmd'
const argvOf = (shell: Shell, command: string) => (shell === 'sh' ? ['sh', '-c', command] : ['cmd', '/d', '/s', '/c', command])
async function shellOf(exec: Exec, cwd: string): Promise<Shell> {
  const r = await exec(['sh', '-c', 'exit 0'], cwd, 15_000).catch(() => null)
  return r?.exitCode === 0 ? 'sh' : 'cmd'
}

// A command the shell could not start: not found, not executable.
const isUnstarted = (exitCode: number) => exitCode === 126 || exitCode === 127 || exitCode === 9009 || exitCode < 0

export const joinRel = (root: string, folder: string) => (folder === ROOT ? root : `${root.replace(/[\\/]$/, '')}/${folder}`)

// The tail of what a red command wrote, so the reason is in it and the turn is not flooded.
function tailOf(stdout: string, stderr: string) {
  const text = [stdout, stderr].filter(s => s.trim() !== '').join('\n').trimEnd()
  const tail = text.split('\n').slice(-OUTPUT_LINES).join('\n')
  return tail.length > OUTPUT_CHARS ? tail.slice(-OUTPUT_CHARS) : tail
}

// git in a folder, names as they are (not quoted octal, which no linter finds), null where it fails.
async function gitIn(exec: Exec, cwd: string, args: string[]) {
  const r = await exec(['git', '-c', 'core.quotePath=false', '-C', cwd, ...args], cwd, 15_000).catch(() => null)
  return r?.exitCode === 0 ? r.stdout : null
}
const namesOf = (out: string | null) => (out ?? '').split('\n').map(s => s.trim()).filter(Boolean)

// The files of a folder changed against its commit and not deleted, from the folder, and those git
// does not know of yet. Outside a repository: none.
async function changedIn(exec: Exec, cwd: string) {
  const [diff, untracked] = await Promise.all([gitIn(exec, cwd, ['diff', 'HEAD', '--name-only', '--relative', '--diff-filter=d']), gitIn(exec, cwd, ['ls-files', '--others', '--exclude-standard'])])
  return [...new Set([...namesOf(diff), ...namesOf(untracked)])]
}

// What the folder's tree is now, to tell a turn that changed it from one that did not: its commit,
// its diff against it, and what git does not know of yet, by content. Outside a repository: nothing.
export async function fingerprintOf(exec: Exec, cwd: string) {
  const [head, diff, untracked] = await Promise.all([gitIn(exec, cwd, ['rev-parse', 'HEAD']), gitIn(exec, cwd, ['diff', 'HEAD', '--relative']), gitIn(exec, cwd, ['ls-files', '--others', '--exclude-standard'])])
  // A folder git lists (a repository of its own) is no file to hash. git hashes them all or none, so
  // where one fails each is hashed alone: the rest still count by their content, that one by its name.
  const names = namesOf(untracked)
  const files = names.filter(n => !n.endsWith('/')).slice(0, HASHED)
  const hashes =
    files.length === 0 ? ''
    : ((await gitIn(exec, cwd, ['hash-object', '--', ...files])) ??
      (await Promise.all(files.map(async f => (await gitIn(exec, cwd, ['hash-object', '--', f])) ?? `${f}: unhashed`))).join('\n'))
  return { head: (head ?? '').trim(), tree: [head ?? '', diff ?? '', names.join('\n'), hashes].join('\0') }
}

// One tier run, folder by folder, each command in turn: what went red, how long each took, and the
// commands that take files and had none, which did not run. A fast command that takes files runs on
// the folder's changed ones; a full one on the whole folder.
export async function runTier(exec: Exec, root: string, tier: Record<string, string[]>, opts: { isFast: boolean; now: () => Promise<number> | number }) {
  const shell = await shellOf(exec, root)
  const failures: GateFailure[] = []
  const timings: Timing[] = []
  const skipped: { folder: string; command: string }[] = []
  for (const [folder, commands] of Object.entries(tier)) {
    const cwd = joinRel(root, folder)
    const files = opts.isFast && commands.some(takesFiles) ? await changedIn(exec, cwd) : []
    for (const command of commands) {
      const line = opts.isFast ? expand(command, files, shell) : command.replace(FILES, '.')
      if (line === null) {
        skipped.push({ folder, command })
        continue
      }
      const at = await opts.now()
      const r = await exec(argvOf(shell, line), cwd, COMMAND_TIMEOUT_MS).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
      timings.push({ folder, command, ms: (await opts.now()) - at, exitCode: r.exitCode })
      if (r.exitCode !== 0) failures.push({ folder, command, exitCode: r.exitCode, output: tailOf(r.stdout, r.stderr) })
    }
  }
  return { failures, timings, skipped }
}

// What was red on each folder's commit, from a run on it.
export const baselineOf = (failures: readonly GateFailure[], heads: Readonly<Record<string, string>>): Record<string, Baseline> =>
  Object.fromEntries(Object.entries(heads).map(([folder, sha]) => [folder, { sha, red: failures.filter(f => f.folder === folder).map(f => f.command) }]))

// The red of a run against what was red on the same commit before the agent: what it changed.
export function newRed(failures: readonly GateFailure[], baseline: Readonly<Record<string, Baseline>>, heads: Readonly<Record<string, string>>) {
  return failures.filter(f => {
    const base = baseline[f.folder]
    return !(base && base.sha !== '' && base.sha === heads[f.folder] && base.red.includes(f.command))
  })
}

// What a validation of the fast tier found: a command too slow for it (one cut at the timeout too),
// one that does not start.
export function timingIssues(timings: readonly Timing[]): DocIssue[] {
  return timings.flatMap((t): DocIssue[] =>
    t.ms > FAST_BUDGET_MS ? [{ file: CONFIG, kind: 'checks-slow', detail: `${whereOf(t)} (${Math.round(t.ms / 1000)}s)` }]
    : isUnstarted(t.exitCode) ? [{ file: CONFIG, kind: 'checks-start', detail: whereOf(t) }]
    : [],
  )
}

// The rules of `.claude/settings.json` every project gets: the usual forms of what cannot be taken
// back. A rule matches a command by its prefix, so it is a rail against the slip, not a sandbox.
// What else to allow or deny is the project's and the person's to say.
export const DENY = ['Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(git reset --hard:*)', 'Bash(git clean -f:*)', 'Bash(rm -rf:*)', 'Bash(rm -fr:*)']

export function permissionIssues(text: string): DocIssue[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return [{ file: SETTINGS, kind: 'permissions-shape', detail: 'not JSON' }]
  }
  const deny = (raw as { permissions?: { deny?: unknown } } | null)?.permissions?.deny
  if (deny !== undefined && !isCommands(deny)) return [{ file: SETTINGS, kind: 'permissions-shape', detail: 'permissions.deny is not a list of rules' }]
  const missing = DENY.filter(rule => !(deny ?? []).includes(rule))
  return missing.length > 0 ? [{ file: SETTINGS, kind: 'permissions-deny', detail: missing.join(', ') }] : []
}
