import { atom, read, update } from 'claude-code'
import type { EngineInterface, Hook, MatchedHook, ModelEffort, ModelUsage, PluginOptions, ToolCallResult } from 'claude-code'

import type { Busy, CaughtRule, Diff, FileDiff, Finding, Hunk, Line, Live, Mode, ShellRun, Spent, Tab } from '../../types/review'
import type { AbovePromptEvent, PaneHook } from '../core/hooks'
import { langIn, restoreLang } from '../core/lang'
import { specInView } from '../spec/lens'
import { below, canonical, changedSpan, diffText, fileDiff, fileText, filesText, fingerprintOf, hunkPatch, joinPath, keptFindings, nameOf, parentOf, parseFindings, parseNotes, parseStatus, parseUnified, samePath, shellText, whereIn, withWhere } from './diff'
import type { Change, Violation } from './rules'
import { caughtOf, describeEdit, describeWrite, isRuleFile, LIVE_SYSTEM, lineOf, noteFor, parseViolations, refusalFor, RULE_NAMES } from './rules'
import { WORDS } from './words'

const beforeAtom = atom({ plugin: 'agent-lens', key: 'review.before' } as const, {} as Record<string, string | null>)
const turnBeforeAtom = atom({ plugin: 'agent-lens', key: 'review.turnBefore' } as const, {} as Record<string, string | null>)
const requestsAtom = atom({ plugin: 'agent-lens', key: 'review.requests' } as const, [] as string[])
const turnRequestAtom = atom({ plugin: 'agent-lens', key: 'review.turnRequest' } as const, '')
const turnAtom = atom({ plugin: 'agent-lens', key: 'review.turn' } as const, null)
const shownAtom = atom({ plugin: 'agent-lens', key: 'review.shown' } as const, null)
const modeAtom = atom({ plugin: 'agent-lens', key: 'review.mode' } as const, 'turn' as Mode)
const tabAtom = atom({ plugin: 'agent-lens', key: 'review.tab' } as const, 'changes' as Tab)
const fileAtom = atom({ plugin: 'agent-lens', key: 'review.file' } as const, null)
const reviewsAtom = atom({ plugin: 'agent-lens', key: 'review.reviews' } as const, {} as Record<string, Finding[]>)
const notesAtom = atom({ plugin: 'agent-lens', key: 'review.notes' } as const, {} as Record<string, string>)
const walkthroughsAtom = atom({ plugin: 'agent-lens', key: 'review.walkthroughs' } as const, {} as Record<string, string>)
const answerAtom = atom({ plugin: 'agent-lens', key: 'review.answer' } as const, null)
const askAboutAtom = atom({ plugin: 'agent-lens', key: 'review.askAbout' } as const, null)
const busyAtom = atom({ plugin: 'agent-lens', key: 'review.busy' } as const, [] as Busy[])
const errorAtom = atom({ plugin: 'agent-lens', key: 'review.error' } as const, null)
const seenAtom = atom({ plugin: 'agent-lens', key: 'review.seen' } as const, [] as string[])
const sentAtom = atom({ plugin: 'agent-lens', key: 'review.sent' } as const, [] as string[])
const dismissedAtom = atom({ plugin: 'agent-lens', key: 'review.dismissed' } as const, [] as string[])
const expandedAtom = atom({ plugin: 'agent-lens', key: 'review.expanded' } as const, {} as Record<string, number>)
const spentAtom = atom({ plugin: 'agent-lens', key: 'review.spent' } as const, { calls: 0, input: 0, cached: 0, output: 0 } as Spent)
// Every file the session has changed as of the last turn with edits: its path and its shown path.
const changedAtom = atom({ plugin: 'agent-lens', key: 'review.changed' } as const, [] as string[])
const turnDirtyAtom = atom({ plugin: 'agent-lens', key: 'review.turnDirty' } as const, null)
const turnShellAtom = atom({ plugin: 'agent-lens', key: 'review.turnShell' } as const, [] as ShellRun[])
const caughtAtom = atom({ plugin: 'agent-lens', key: 'review.caught' } as const, [] as CaughtRule[])

export const PANE = 'agent-lens-review'
const TABS: readonly Tab[] = ['changes', 'findings', 'walkthrough', 'ask']
const MODES: readonly Mode[] = ['turn', 'session', 'uncommitted']
// Reading code wants care more than speed: the session's mid-sized model.
const MODEL = 'sonnet'
const TIMEOUT_MS = 180_000
// Each edit is checked as it is made by a small model, quick and cheap: a call per edit.
const LIVE_TIMEOUT_MS = 30_000
// A turn's end waits this long for the checks of its edits still running.
const STOP_WAIT_MS = 8_000
// What was caught is kept, newest first, up to this many.
const CAUGHT_LIMIT = 30
// The main loop's key among the loops whose notes wait for Claude; a subagent's is its id.
const MAIN = ''
// A rule file is read up to this, and all of them together up to the second.
const RULE_FILE_LIMIT = 16_000
const RULES_LIMIT = 48_000
// A changed file is sent whole up to this, else the lines around its hunks; all of them up to the
// characters after it. Each call pays for them, the cache aside: a few thousand tokens a file.
const FILE_LIMIT = { lines: 300, chars: 12_000 }
const FILES_LIMIT = 32_000
// A turn that touched no more lines than this, added or removed, is not reviewed by itself: the row
// says so, and `r` on Findings reviews it.
const SMALL_LINES = 2
// A hunk shows this many lines before it says how many more it has, and this many more on each
// press of `show more`.
const HUNK_LINES = 40
const HUNK_STEP = 200
// How each kind of finding is drawn: a likely bug red, a broken rule yellow, a note blue.
const SEVERITY = {
  bug: { icon: '✗', color: 'error' },
  rule: { icon: '!', color: 'warning' },
  note: { icon: '·', color: 'suggestion' },
} as const

// The line numbers before each line of code: old and new, four wide each.
const GUTTER = 10
// Untracked files read in the uncommitted diff, at most.
const UNTRACKED_LIMIT = 40
// Uncommitted files taken before a shell command, and found changed by it, at most, per repository.
const SHELL_LIMIT = 100
// What a review reads beside the diff, so it does not call a change unasked for or a step undone:
// the session's earlier prompts, the turn's shell commands with the end of their output, and the
// files of each repository changed. Each up to this many, cut to these lengths.
const EARLIER = { count: 12, chars: 1_500 }
const SHELL_RUNS = { count: 40, command: 500, output: 400 }
const REPO_FILES_LIMIT = 300

// The repository each folder is in, by `git rev-parse`, each path in its one spelling (`canonical`);
// null outside any.
const repos = new Map<string, string | null>()
// A review asked for while one runs: made once that one is done.
let reviewNext: Diff | undefined
// What was uncommitted being taken before the turn's first shell command: the commands run side by
// side wait on the one taking, so none is counted before it.
let shellTaking: Promise<void> | undefined
// The plugin's settings, as `/config` holds them.
let settings = settingsOf({})
// What the check of each edit found for Claude, by loop, until a tool result or the turn's end
// carries it; the checks running, by loop; the loops a classic Stop hook already sent back this
// turn; and whether the main loop's last turn was sent back, so the next is let go.
const notes = new Map<string, string[]>()
const pending = new Map<string, Set<Promise<void>>>()
const stopped = new Set<string>()
let sentBack = false

function settingsOf(options: PluginOptions) {
  const live: Live = options.live === 'block' || options.live === 'off' ? options.live : 'warn'
  const model = typeof options.liveModel === 'string' && options.liveModel.trim() !== '' ? options.liveModel.trim() : 'haiku'
  return { live, liveModel: model, includeUserRules: options.includeUserRules === true }
}

async function wordsIn($: EngineInterface) {
  return WORDS[await langIn($)]
}
const whyNot = (r: { reason: string; status?: number | null }) => (r.status ? `${r.reason} ${r.status}` : r.reason)

async function readOrNull($: EngineInterface, path: string) {
  if (!(await $.fs.exists(path).catch(() => false))) return null
  return ((await $.fs.read(path).catch(() => null)) as string | null) ?? null
}

const shownFrom = (root: string) => (path: string) => below(path, root) ?? path

// Git prints a path with a byte past ASCII in it quoted and escaped, but for this.
const GIT = ['git', '-c', 'core.quotePath=false']

// The repository `dir` is in. Git on Windows says `D:/proj` where the engine says `D:\proj`: the
// two spelled one way, so a file is one key in `before` however it was found.
async function repoAt($: EngineInterface, dir: string) {
  const key = canonical(dir)
  if (!repos.has(key)) {
    const r = await $.process.run([...GIT, '-C', key, 'rev-parse', '--show-toplevel'], { timeoutMs: 10_000 }).catch(() => undefined)
    repos.set(key, r && r.exitCode === 0 && r.stdout.trim() !== '' ? canonical(r.stdout.trim()) : null)
  }
  return repos.get(key) ?? null
}

function repoOf($: EngineInterface, path: string) {
  return repoAt($, parentOf(path))
}

// The project's own repository first, then the others by name; files by their path in each.
const byGroup = (a: FileDiff, b: FileDiff) => (a.group === b.group ? a.rel.localeCompare(b.rel) : a.group === '' ? -1 : b.group === '' ? 1 : a.group.localeCompare(b.group))

// What changed since `before` was taken: each file as it was against what is on disk now.
async function snapshotDiff($: EngineInterface, before: Readonly<Record<string, string | null>>) {
  const root = await $.session.root()
  const files: FileDiff[] = []
  for (const [path, was] of Object.entries(before)) {
    const f = fileDiff(path, whereIn(path, root, await repoOf($, path)), was, await readOrNull($, path))
    if (f.hunks.length > 0) files.push(f)
  }
  return files.sort(byGroup)
}

function git($: EngineInterface, repo: string, args: string[]) {
  return $.process.run([...GIT, '-C', repo, ...args], { timeoutMs: 30_000 }).catch(() => undefined)
}

// Every repository the session edited a file in, and the project's own.
async function sessionRepos($: EngineInterface) {
  const found = new Set<string>()
  const own = await repoAt($, await $.session.root())
  if (own) found.add(own)
  for (const path of Object.keys(await read($, beforeAtom))) {
    const repo = await repoOf($, path)
    if (repo) found.add(repo)
  }
  return [...found]
}

// What is uncommitted in every repository the session edited a file in, and in the project's own:
// `git diff HEAD`, and each untracked file whole.
async function uncommittedDiff($: EngineInterface) {
  const root = await $.session.root()
  const files: FileDiff[] = []
  for (const repo of await sessionRepos($)) {
    const run = (args: string[]) => git($, repo, args)
    // A repository with no commit yet has no HEAD to compare with: the index stands in for it.
    const head = await run(['diff', 'HEAD', '--no-color', '--no-ext-diff', '-U3'])
    const tracked = head?.exitCode === 0 ? head : await run(['diff', '--no-color', '--no-ext-diff', '-U3'])
    if (tracked && tracked.exitCode === 0) files.push(...parseUnified(tracked.stdout, repo, p => whereIn(p, root, repo)))
    const untracked = await run(['ls-files', '--others', '--exclude-standard'])
    for (const rel of (untracked?.stdout ?? '').split(/\r?\n/).filter(Boolean).slice(0, UNTRACKED_LIMIT)) {
      const path = joinPath(repo, rel)
      const f = fileDiff(path, whereIn(path, root, repo), null, await readOrNull($, path))
      if (f.hunks.length > 0) files.push(f)
    }
  }
  return files.sort(byGroup)
}

async function diffFor($: EngineInterface, mode: Mode): Promise<Diff | null> {
  if (mode === 'turn') {
    const turn = await read($, turnAtom)
    return turn && { ...turn, files: withWhere(turn.files, await $.session.root()) }
  }
  const files = mode === 'session' ? await snapshotDiff($, await read($, beforeAtom)) : await uncommittedDiff($)
  return { mode, files, request: (await read($, requestsAtom)).join('\n\n'), fingerprint: fingerprintOf(files), at: await $.clock.now() }
}

// The pane follows the mode picked; the file picked stays while the diff still has it.
async function refreshShown($: EngineInterface) {
  const shown = await diffFor($, await read($, modeAtom))
  await update($, shownAtom, () => shown)
  const picked = await read($, fileAtom)
  if (!shown?.files.some(f => f.path === picked)) await update($, fileAtom, () => shown?.files[0]?.path ?? null)
}

async function withBusy($: EngineInterface, kind: Busy, work: () => Promise<void>) {
  if ((await read($, busyAtom)).includes(kind)) return
  await update($, busyAtom, b => [...b, kind])
  await update($, errorAtom, () => null)
  try {
    await work()
  } finally {
    await update($, busyAtom, b => b.filter(k => k !== kind))
  }
}

// The personal CLAUDE.md, where Claude Code keeps it.
async function userRulesPath($: EngineInterface) {
  const config = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  if (config) return joinPath(config, 'CLAUDE.md')
  const home = (await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined))
  return home ? joinPath(home, '.claude/CLAUDE.md') : undefined
}

// The rules in force for `paths`, nearest first, each once, as the engine reads them, its
// `@include`s after each: the CLAUDE.md and AGENTS.md of every folder from each file up to the
// project folder (a file outside it up to its own repository's root, outside any its own folder
// alone), then those the engine read at the start, from the project folder up. The personal
// CLAUDE.md only where the settings ask for it.
async function ruleFilesFor($: EngineInterface, paths: readonly string[]) {
  const root = await $.session.root()
  const found: { path: string; text: string }[] = []
  const take = (walked: Awaited<ReturnType<EngineInterface['fs']['ancestors']>>) => {
    // Root first, so turned round, each folder's names in their order.
    const dirs = [...new Set(walked.map(a => canonical(a.dir)))].reverse()
    for (const dir of dirs)
      for (const rules of walked.filter(a => canonical(a.dir) === dir)) {
        const path = canonical(rules.parts[0]?.path ?? joinPath(rules.dir, rules.name))
        if (!found.some(f => f.path === path)) found.push({ path, text: rules.content })
      }
  }
  for (const path of paths) {
    const top = below(path, root) !== undefined ? root : ((await repoOf($, path)) ?? parentOf(path))
    // The walk reads only the folders strictly inside `below`: from the one above the top, the
    // top's own are read too.
    take(await $.fs.ancestors({ names: RULE_NAMES, of: path, below: parentOf(top) }).catch(() => []))
  }
  take(await $.fs.ancestors({ names: RULE_NAMES }).catch(() => []))
  const user = await userRulesPath($)
  if (user && settings.includeUserRules && !found.some(f => samePath(f.path, user))) {
    const text = await readOrNull($, user)
    if (text !== null) found.push({ path: canonical(user), text })
  }
  return found.filter(f => f.text.trim() !== '' && (settings.includeUserRules || !user || !samePath(f.path, user)))
}

const rulesText = (found: readonly { path: string; text: string }[], shown: (path: string) => string) => {
  let text = ''
  for (const rules of found) {
    if (text.length > RULES_LIMIT) break
    text += `=== ${shown(rules.path)} ===\n${rules.text.replace(/\r\n/g, '\n').slice(0, RULE_FILE_LIMIT)}\n\n`
  }
  return text
}

async function rulesFor($: EngineInterface, files: readonly FileDiff[]) {
  const w = await wordsIn($)
  const text = rulesText(await ruleFilesFor($, files.map(f => f.path)), shownFrom(await $.session.root()))
  return text === '' ? w.noRules : `${w.rulesHeading}\n\n${text}`
}

const isSmall = (diff: Diff) =>
  Math.max(
    diff.files.reduce((n, f) => n + f.added, 0),
    diff.files.reduce((n, f) => n + f.removed, 0),
  ) <= SMALL_LINES

// Each changed file as it is on disk now, its lines numbered; a deleted one, or one edited since
// the diff was taken, goes without.
async function filesFor($: EngineInterface, files: readonly FileDiff[]) {
  const texts: Record<string, string> = {}
  for (const f of files) {
    const now = f.isDeleted ? null : await readOrNull($, f.path)
    const text = now === null ? undefined : fileText(f, now, FILE_LIMIT)
    if (text !== undefined) texts[f.path] = text
  }
  return filesText(files, texts, FILES_LIMIT)
}

// The files of each repository the diff changed a file in, tracked or new and not ignored: what
// a path in the diff is checked against.
async function repoFilesFor($: EngineInterface, files: readonly FileDiff[]) {
  const w = await wordsIn($)
  const root = await $.session.root()
  const shown = (repo: string) => (samePath(repo, root) ? '' : shownFrom(root)(repo))
  const repos = new Set<string>()
  for (const f of files) {
    const repo = await repoOf($, f.path)
    if (repo) repos.add(repo)
  }
  let text = ''
  for (const repo of repos) {
    const r = await git($, repo, ['ls-files', '--cached', '--others', '--exclude-standard'])
    if (r?.exitCode !== 0) continue
    const all = [...new Set(r.stdout.split(/\r?\n/).filter(Boolean))]
    if (all.length === 0) continue
    text += `${w.repoFilesHeading(shown(repo), all.length - REPO_FILES_LIMIT)}\n${all.slice(0, REPO_FILES_LIMIT).join('\n')}\n\n`
  }
  return text
}

// What every question about a diff reads: the requests, the commands run, the files changed and
// those beside them, the diff.
async function contextFor($: EngineInterface, diff: Diff) {
  const w = await wordsIn($)
  const files = await filesFor($, diff.files)
  const earlier = diff.earlier?.length ? `${w.earlierHeading}\n\n${diff.earlier.map(r => `- ${r}`).join('\n')}\n\n` : ''
  const shell = diff.shell?.length ? `${w.shellHeading}\n\n${shellText(diff.shell)}\n\n` : ''
  // The OpenSpec change in view, where the project has one: what the diff may be working on.
  const spec = await specInView($).catch(() => undefined)
  const inView = spec ? `${w.specHeading(spec)}\n\n` : ''
  return `${inView}${earlier}${w.requestHeading(diff.request)}\n\n${shell}${files ? `${w.filesHeading}\n\n${files}` : ''}${await repoFilesFor($, diff.files)}${w.diffHeading}\n\n${diffText(diff.files)}`
}

async function spend($: EngineInterface, u: ModelUsage) {
  await update($, spentAtom, s => ({
    calls: s.calls + 1,
    input: s.input + u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
    cached: s.cached + u.cache_read_input_tokens,
    output: s.output + u.output_tokens,
  }))
}

// The rules, then the request, the files and the diff, then what is asked: the first two marked,
// so the review, the explanations, the walkthrough and the answers on one diff read them from the
// cache and only the ask is new.
async function complete($: EngineInterface, diff: Diff, ask: string, maxTokens: number, effort: ModelEffort) {
  const w = await wordsIn($)
  const r = await $.model.complete({
    model: MODEL,
    system: w.system,
    prompt: [{ text: await rulesFor($, diff.files), cache: true }, { text: await contextFor($, diff), cache: true }, { text: ask }],
    maxTokens,
    effort,
    timeoutMs: TIMEOUT_MS,
  })
  await spend($, r.usage)
  if (!r.isAnswered) await update($, errorAtom, () => w.failed(whyNot(r)))
  return r.isAnswered ? r.text : undefined
}

async function reviewDiff($: EngineInterface, diff: Diff) {
  if (diff.files.length === 0 || (await read($, reviewsAtom))[diff.fingerprint]) return
  if ((await read($, busyAtom)).includes('review')) {
    reviewNext = diff
    return
  }
  await withBusy($, 'review', async () => {
    const w = await wordsIn($)
    // What the check of each edit caught and the person sees already is not found again.
    const names = diff.files.flatMap(f => [f.path, f.shown])
    const flagged = (await openCaught($)).filter(c => isOn(c, names)).map(c => ({ where: findingAt(c), rule: c.rule ?? c.text }))
    const isSpec = (await specInView($).catch(() => undefined)) !== undefined
    const ask = [w.reviewPrompt, ...(isSpec ? [w.specPrompt] : []), ...(flagged.length > 0 ? [w.flaggedPrompt(flagged)] : [])].join('\n\n')
    // Room for the few sentences it may reason in before the JSON.
    const text = await complete($, diff, ask, 8000, 'high')
    if (text === undefined) return
    const findings = parseFindings(text)
    if (findings === undefined) {
      await update($, errorAtom, () => w.failed('the reply was not JSON'))
      return
    }
    // A second, doubting look at what the first found, over the same cached text: it drops a
    // finding that an earlier request, a command run or a file listed shows to be no problem.
    const checked = findings.length === 0 ? undefined : await complete($, diff, w.verifyPrompt(findings.map(f => ({ where: findingAt(f), text: f.text }))), 4000, 'medium')
    const kept = (checked === undefined ? undefined : keptFindings(checked, findings)) ?? findings
    await update($, reviewsAtom, all => ({ ...all, [diff.fingerprint]: kept }))
  })
  const next = reviewNext
  reviewNext = undefined
  if (next) await reviewDiff($, next)
}

async function explainHunks($: EngineInterface) {
  const diff = await read($, shownAtom)
  const notes = await read($, notesAtom)
  const ids = (diff?.files ?? []).flatMap(f => f.hunks.map(hunk => hunk.id))
  const missing = ids.filter(id => notes[id] === undefined)
  if (!diff || missing.length === 0) return
  await withBusy($, 'notes', async () => {
    const w = await wordsIn($)
    // The whole diff is sent, as to the review, so it is read from the cache; the ask names the
    // hunks still unsaid.
    const text = await complete($, diff, w.notesPrompt(missing.length < ids.length ? missing : null), 3000, 'low')
    if (text === undefined) return
    const said = parseNotes(text, missing)
    await update($, notesAtom, all => ({ ...all, ...said }))
  })
}

async function walkThrough($: EngineInterface, isAgain = false) {
  const diff = await read($, shownAtom)
  if (!diff || diff.files.length === 0 || (!isAgain && (await read($, walkthroughsAtom))[diff.fingerprint])) return
  await withBusy($, 'walkthrough', async () => {
    const text = await complete($, diff, (await wordsIn($)).walkthroughPrompt, 3000, 'medium')
    if (text !== undefined) await update($, walkthroughsAtom, all => ({ ...all, [diff.fingerprint]: text }))
  })
}

const hunkOf = (diff: Diff | null, id: string | null) => {
  for (const f of diff?.files ?? []) for (const hunk of f.hunks) if (hunk.id === id) return { f, hunk }
  return undefined
}

// A run of removed lines followed by as many added ones reads as each line rewritten: each pair is
// split around what changed, so the change itself can be lit. By the line's index in `lines`.
const pairedSpans = (lines: readonly Line[]) => {
  const spans: (ReturnType<typeof changedSpan> | undefined)[] = []
  for (let k = 0; k < lines.length; ) {
    let removed = 0
    while (lines[k + removed]?.kind === '-') removed++
    let added = 0
    while (lines[k + removed + added]?.kind === '+') added++
    if (removed > 0 && removed === added)
      for (let j = 0; j < removed; j++) spans[k + j] = spans[k + removed + j] = changedSpan(lines[k + j]!.text, lines[k + removed + j]!.text)
    k += Math.max(1, removed + added)
  }
  return spans
}

const whereOf = (f: FileDiff, hunk: Hunk) => `${f.shown}:${hunk.newStart}`

async function ask($: EngineInterface, question: string) {
  const q = question.trim()
  const diff = await read($, shownAtom)
  if (!diff || q === '') return
  const about = hunkOf(diff, await read($, askAboutAtom))
  await update($, answerAtom, () => null)
  await withBusy($, 'answer', async () => {
    const w = await wordsIn($)
    const text = await complete($, diff, w.askPrompt(q, about ? hunkPatch(about.f, about.hunk) : null), 2000, 'medium')
    if (text !== undefined) await update($, answerAtom, () => ({ question: q, text }))
  })
}

// Sends `text` to the session as the person's prompt and marks `ids` as sent.
async function sendToClaude($: EngineInterface, ids: readonly string[], text: string) {
  const w = await wordsIn($)
  const r = await $.prompt.submit({ text, asUser: true })
  if (r.drop !== undefined) {
    const why = r.drop
    await update($, errorAtom, () => why)
    return
  }
  await update($, sentAtom, s => [...s, ...ids])
  await $.ui.toast(w.sent)
}

const findingAt = (f: Finding) => (f.line ? `${f.file}:${f.line}` : f.file)

async function fixFinding($: EngineInterface, f: Finding) {
  const w = await wordsIn($)
  await sendToClaude($, [f.id], w.fixPrompt(findingAt(f), f.text, f.rule))
}

// Every finding still open, in one prompt: one turn for Claude, not one per finding.
async function fixAll($: EngineInterface, findings: readonly Finding[]) {
  const w = await wordsIn($)
  await sendToClaude($, findings.map(f => f.id), w.fixAllPrompt(findings.map(f => ({ where: findingAt(f), text: f.text, rule: f.rule }))))
}

async function revertHunk($: EngineInterface, f: FileDiff, hunk: Hunk) {
  const w = await wordsIn($)
  await sendToClaude($, [hunk.id], w.revertPrompt(f.shown, hunkPatch(f, hunk)))
}

async function markSeen($: EngineInterface, ids: readonly string[]) {
  await update($, seenAtom, seen => [...new Set([...seen, ...ids])])
}

// Each tab asks the model only when it is looked at, and once per version of the diff.
async function openTab($: EngineInterface, tab: Tab) {
  await update($, tabAtom, () => tab)
  // The ring goes with the tab, so what is lit is what is open; on Ask, into the question.
  void $.ui.focus({ requestId: PANE, key: tab === 'ask' ? 'question' : `tab-${tab}` }).catch(() => {})
  if (tab === 'changes') await explainHunks($)
  else if (tab === 'walkthrough') await walkThrough($)
}

// From a finding to its code: the file picked on Changes, the ring on the hunk that holds its line.
async function goToCode($: EngineInterface, f: Finding) {
  const find = (diff: Diff | null) => diff?.files.find(x => x.shown === f.file || x.rel === f.file)
  // A finding of an earlier review may be on a file the diff in view does not hold: the session's does.
  if (!find(await read($, shownAtom)) && (await read($, modeAtom)) !== 'session') await setMode($, 'session')
  const file = find(await read($, shownAtom))
  if (!file) return
  await update($, fileAtom, () => file.path)
  await openTab($, 'changes')
  const hunk = file.hunks.find(h => f.line !== undefined && f.line >= h.newStart && f.line < h.newStart + h.lines.filter(l => l.kind !== '-').length) ?? file.hunks[0]
  if (hunk) void $.ui.focus({ requestId: PANE, key: `ask-${hunk.id}` }).catch(() => {})
}

async function setMode($: EngineInterface, mode: Mode) {
  await update($, modeAtom, () => mode)
  await update($, answerAtom, () => null)
  await update($, askAboutAtom, () => null)
  await refreshShown($)
  await openTab($, await read($, tabAtom))
}

export async function openPane($: EngineInterface) {
  await refreshShown($)
  const w = await wordsIn($)
  await $.ui.open({ id: PANE, title: w.title, focus: true, closeOnEscape: true })
  void openTab($, await read($, tabAtom)).catch(() => {})
}

// After a turn that edited files, what it changed becomes the last turn's diff and is reviewed,
// unless it touched a line or two.
async function afterTurn($: EngineInterface) {
  await afterShell($)
  await resolveCaught($)
  // Taken and emptied in one write, the request with them: the next turn may start, and edit, while
  // this one's diff is read from the disk.
  let before: Readonly<Record<string, string | null>> = {}
  await update($, turnBeforeAtom, b => {
    before = b
    return {}
  })
  let shell: ShellRun[] = []
  await update($, turnShellAtom, s => {
    shell = s
    return []
  })
  const request = await read($, turnRequestAtom)
  const requests = await read($, requestsAtom)
  const at = requests.lastIndexOf(request)
  const earlier = (at >= 0 ? requests.slice(0, at) : requests).slice(-EARLIER.count).map(r => r.slice(0, EARLIER.chars))
  if (Object.keys(before).length === 0) return
  const files = await snapshotDiff($, before)
  const session = await snapshotDiff($, await read($, beforeAtom))
  await update($, changedAtom, () => session.flatMap(f => [f.path, f.shown]))
  if (files.length === 0) return
  const turn: Diff = { mode: 'turn', files, request, earlier, shell, fingerprint: fingerprintOf(files), at: await $.clock.now() }
  await update($, turnAtom, () => turn)
  if ((await read($, modeAtom)) === 'turn') await update($, shownAtom, () => turn)
  await refreshShown($)
  if (!isSmall(turn)) await reviewDiff($, turn)
}

// The key `path` is kept by in `kept`: one there that is the same path spelled otherwise (Windows
// folds case: the model's `D:\Proj\a.ts` is git's `D:\proj\a.ts`), else its one spelling.
const keyIn = (kept: Readonly<Record<string, unknown>>, path: string) => Object.keys(kept).find(k => samePath(k, path)) ?? canonical(path)

// A file is kept by one key however the edit tools and git name it.
async function remember($: EngineInterface, named: string) {
  const path = keyIn(await read($, beforeAtom), named)
  if (path in (await read($, turnBeforeAtom)) && path in (await read($, beforeAtom))) return
  const was = await readOrNull($, path)
  // Only the first taking of a file counts: an edit made since is not what it was.
  await update($, turnBeforeAtom, b => (path in b ? b : { ...b, [path]: was }))
  await update($, beforeAtom, b => (path in b ? b : { ...b, [path]: was }))
}

// Every file uncommitted in `repo`, by path: modified, staged, deleted or untracked.
async function uncommittedIn($: EngineInterface, repo: string) {
  const r = await git($, repo, ['status', '--porcelain', '-z', '--untracked-files=all'])
  return r?.exitCode === 0 ? parseStatus(r.stdout).map(rel => joinPath(repo, rel)) : []
}

// A shell command edits files no tool call names. Before the turn's first, what is uncommitted is
// taken as an edit would take it, and named: what is uncommitted after and was not, the shell did.
async function beforeShell($: EngineInterface) {
  if ((await read($, turnDirtyAtom)) !== null) return
  shellTaking ??= (async () => {
    const dirty: Record<string, string[]> = {}
    for (const repo of await sessionRepos($)) {
      dirty[repo] = await uncommittedIn($, repo)
      for (const path of dirty[repo].slice(0, SHELL_LIMIT)) await remember($, path)
    }
    await update($, turnDirtyAtom, d => d ?? dirty)
  })()
  await shellTaking
}

// After a turn that ran the shell: each file uncommitted now and not before it, and edited by no
// tool, the shell changed; it was as committed, or not there.
async function afterShell($: EngineInterface) {
  const taken: { dirty: Readonly<Record<string, readonly string[]>> | null } = { dirty: null }
  await update($, turnDirtyAtom, d => {
    taken.dirty = d
    return null
  })
  shellTaking = undefined
  for (const [repo, was] of Object.entries(taken.dirty ?? {})) {
    const edited = await read($, turnBeforeAtom)
    const found = (await uncommittedIn($, repo)).filter(path => !was.includes(path) && !(keyIn(edited, path) in edited)).slice(0, SHELL_LIMIT)
    for (const named of found) {
      const head = await git($, repo, ['show', `HEAD:${below(named, repo) ?? ''}`])
      // Cut short, it is not what the file was.
      if (head?.isStdoutTruncated) continue
      const before = head?.exitCode === 0 ? head.stdout : null
      const path = keyIn(await read($, beforeAtom), named)
      await update($, turnBeforeAtom, b => (path in b ? b : { ...b, [path]: before }))
      await update($, beforeAtom, b => (path in b ? b : { ...b, [path]: before }))
    }
  }
}

// A shell command of the turn, for the review to read: what a push or an install did is in no diff.
async function noteShell($: EngineInterface, command: string, ran: ToolCallResult<'Bash'>) {
  const output = ran.deny !== undefined ? ran.deny : ran.isError ? (ran.text ?? '') : [ran.result.stdout, ran.result.stderr].filter(Boolean).join('\n')
  const run: ShellRun = {
    command: command.slice(0, SHELL_RUNS.command),
    output: output.trim().slice(-SHELL_RUNS.output),
    isError: ran.deny !== undefined || ran.isError === true,
  }
  await update($, turnShellAtom, s => [...s, run].slice(-SHELL_RUNS.count))
}

// One edit checked against the rules in force for its file by the small model; an edit to a rule
// file, or to a file no rule applies to, is let be.
async function inspect($: EngineInterface, change: Change) {
  if (isRuleFile(change.file)) return []
  const rules = rulesText(await ruleFilesFor($, [change.file]), shownFrom(await $.session.root()))
  if (rules === '') return []
  const r = await $.model.complete({
    model: settings.liveModel,
    system: LIVE_SYSTEM,
    prompt: [{ text: rules, cache: true }, { text: `\n\n# The change\n\n${change.text}` }],
    maxTokens: 1024,
    effort: 'low',
    timeoutMs: LIVE_TIMEOUT_MS,
  })
  await spend($, r.usage)
  return r.isAnswered ? (parseViolations(r.text) ?? []) : []
}

// What the check caught joins the findings, a toast says so; caught again, it is told again.
async function keepCaught($: EngineInterface, change: Change, violations: readonly Violation[], state: CaughtRule['state']) {
  const path = canonical(change.file)
  const shown = whereIn(path, await $.session.root(), await repoOf($, path)).shown
  const now = state === 'refused' ? null : await readOrNull($, path)
  const caught = violations.map(v => caughtOf(path, shown, v, change, now, state))
  await update($, caughtAtom, all => [...caught, ...all.filter(c => !caught.some(n => n.id === c.id))].slice(0, CAUGHT_LIMIT))
  await $.ui.toast((await wordsIn($)).caughtToast(violations.length, nameOf(path)))
}

const takeNotes = (loop: string) => {
  const list = notes.get(loop) ?? []
  notes.delete(loop)
  return list
}

// The check runs beside the turn, so an edit is not held for it: its note rides on the loop's next
// tool result, or goes with the turn's end.
function checkInBackground($: EngineInterface, loop: string, change: Change) {
  const running = pending.get(loop) ?? new Set<Promise<void>>()
  pending.set(loop, running)
  const done = new Promise<void>(resolve => {
    $.clock.after(0, () => {
      inspect($, change)
        .then(async violations => {
          if (violations.length === 0) return
          notes.set(loop, [...(notes.get(loop) ?? []), noteFor(change.file, violations)])
          await keepCaught($, change, violations, 'told')
        })
        .catch(() => undefined)
        .finally(resolve)
    })
  })
  running.add(done)
  void done.then(() => running.delete(done))
}

// The notes of `loop`, once the checks it still runs are done or the wait is up.
async function settle($: EngineInterface, loop: string) {
  const running = pending.get(loop)
  if (running?.size) await Promise.race([Promise.all(running), $.clock.sleep(STOP_WAIT_MS).catch(() => undefined)])
  return takeNotes(loop)
}

// Where no classic Stop hook ran, as where an organization manages Claude Code: a main turn that
// ended with notes unread gets them as a prompt of its own, once; a subagent's go to the main loop.
async function settleTurn($: EngineInterface, agentId: string | undefined, reason: string) {
  const loop = agentId ?? MAIN
  if (stopped.delete(loop)) return
  if (loop !== MAIN) {
    const delivered = await settle($, loop)
    if (delivered.length > 0) notes.set(MAIN, [...(notes.get(MAIN) ?? []), ...delivered.map(note => `A subagent left this unfixed:\n${note}`)])
    return
  }
  const wasSentBack = sentBack
  sentBack = false
  if (reason !== 'answer') return
  const delivered = await settle($, MAIN)
  if (delivered.length === 0 || wasSentBack) return
  sentBack = true
  void $.prompt.submit({ text: delivered.join('\n\n') }).catch(() => undefined)
}

// After a turn, what was caught while it ran is looked for again: still in its file, it is open as
// any finding; gone, Claude fixed it. One whose evidence the edit did not hold as quoted stays told,
// and the review after the turn reads its file.
async function resolveCaught($: EngineInterface) {
  const now = new Map<string, string | null>()
  for (const c of await read($, caughtAtom))
    if (c.evidence !== undefined && (c.state === 'told' || c.state === 'open') && !now.has(c.path)) now.set(c.path, await readOrNull($, c.path))
  await update($, caughtAtom, all =>
    all.map(c => {
      const text = now.get(c.path)
      if (c.evidence === undefined || text === undefined || (c.state !== 'told' && c.state !== 'open')) return c
      const line = text === null ? undefined : lineOf(text, c.evidence)
      const { line: _was, ...rest } = c
      return line === undefined ? { ...rest, state: 'fixed' as const } : { ...rest, line, state: 'open' as const }
    }),
  )
}

const open = (f: Finding, sent: readonly string[], dismissed: readonly string[]) => !sent.includes(f.id) && !dismissed.includes(f.id)

// What was caught as Claude edited and is still in the code, neither sent to Claude nor put aside.
async function openCaught($: EngineInterface) {
  const sent = await read($, sentAtom)
  const dismissed = await read($, dismissedAtom)
  return (await read($, caughtAtom)).filter(c => c.state === 'open' && open(c, sent, dismissed))
}

// Whether a finding is on one of `names`, paths and shown paths, as the model named its file: by
// `/`, as a Windows path may be named either way.
const isOn = (f: Finding, names: readonly string[]) => {
  const file = f.file.replace(/\\/g, '/').replace(/^\.\//, '')
  return names.some(n => n === f.file || n.replace(/\\/g, '/').endsWith(`/${file}`))
}

// The findings of every review but `diff`'s still open, each once: a finding stays until it is sent
// to Claude or put aside, while its file is still changed in the session (or uncommitted, in view).
async function earlierFindings($: EngineInterface, diff: Diff | null) {
  const reviews = await read($, reviewsAtom)
  const sent = await read($, sentAtom)
  const dismissed = await read($, dismissedAtom)
  const names = [...(await read($, changedAtom)), ...(diff?.mode === 'uncommitted' ? diff.files.flatMap(f => [f.path, f.shown]) : [])]
  const taken = new Set((diff ? (reviews[diff.fingerprint] ?? []) : []).map(f => f.id))
  return Object.entries(reviews)
    .filter(([fingerprint]) => fingerprint !== diff?.fingerprint)
    .flatMap(([, findings]) => findings)
    .filter(f => {
      if (taken.has(f.id) || !open(f, sent, dismissed) || !isOn(f, names)) return false
      taken.add(f.id)
      return true
    })
}

export async function registerCommand($: EngineInterface) {
  await $.command.register({ name: 'changes', description: (await wordsIn($)).description, argumentHint: '[rules|lang en|ru]' })
}

export function configureReview(options: PluginOptions) {
  settings = settingsOf(options)
}

export async function startReview($: EngineInterface) {
  // A reload runs this again with nothing in flight: a review the old module was running when it
  // went would hold `busy` for good, and every review after it would wait on it.
  await update($, busyAtom, () => [])
  await restoreLang($)
  await registerCommand($)
}

export async function turnStart($: Parameters<Hook<'turn.start'>>[0], e: Parameters<Hook<'turn.start'>>[1], next: Parameters<Hook<'turn.start'>>[2]) {
  if (e.agentId === undefined) {
    await update($, turnBeforeAtom, () => ({}))
    await update($, turnDirtyAtom, () => null)
    await update($, turnShellAtom, () => [])
    shellTaking = undefined
    await update($, turnRequestAtom, () => e.text)
    if (e.text.trim() !== '') await update($, requestsAtom, r => [...r, e.text])
  }
  return next(e)
}

// Every edit, a subagent's too, is taken before it runs: what the file was is what the turn
// and the session are compared with.
export async function beforeWrite($: Parameters<MatchedHook<'tool.call', { tool: 'Write' }>>[0], e: Parameters<MatchedHook<'tool.call', { tool: 'Write' }>>[1], next: Parameters<MatchedHook<'tool.call', { tool: 'Write' }>>[2]) {
  await remember($, e.file_path).catch(() => {})
  return next(e)
}

export async function beforeEdit($: Parameters<MatchedHook<'tool.call', { tool: 'Edit' }>>[0], e: Parameters<MatchedHook<'tool.call', { tool: 'Edit' }>>[1], next: Parameters<MatchedHook<'tool.call', { tool: 'Edit' }>>[2]) {
  await remember($, e.file_path).catch(() => {})
  return next(e)
}

export async function beforeNotebookEdit($: Parameters<MatchedHook<'tool.call', { tool: 'NotebookEdit' }>>[0], e: Parameters<MatchedHook<'tool.call', { tool: 'NotebookEdit' }>>[1], next: Parameters<MatchedHook<'tool.call', { tool: 'NotebookEdit' }>>[2]) {
  await remember($, e.notebook_path).catch(() => {})
  return next(e)
}

export async function aroundShell($: Parameters<MatchedHook<'tool.call', { tool: 'Bash' }>>[0], e: Parameters<MatchedHook<'tool.call', { tool: 'Bash' }>>[1], next: Parameters<MatchedHook<'tool.call', { tool: 'Bash' }>>[2]) {
  await beforeShell($).catch(() => {})
  const ran = await next(e)
  await noteShell($, e.command, ran).catch(() => {})
  return ran
}

type ToolCallEvent = Parameters<Hook<'tool.call'>>[1]
type ToolCallDone = Awaited<ReturnType<Parameters<Hook<'tool.call'>>[2]>>

const changeOf = (e: ToolCallEvent) =>
  settings.live === 'off' ? undefined
  : e.tool === 'Edit' ? describeEdit(e.file_path, e.old_string, e.new_string)
  : e.tool === 'Write' ? describeWrite(e.file_path, e.content)
  : undefined

// Each edit checked against the rules as it is made: before it lands, to refuse it, in `block`.
export async function checkBefore($: EngineInterface, e: ToolCallEvent) {
  const change = changeOf(e)
  if (!change || settings.live !== 'block') return undefined
  const violations = await inspect($, change).catch(() => [])
  if (violations.length === 0) return undefined
  await keepCaught($, change, violations, 'refused').catch(() => {})
  return refusalFor(change.file, violations)
}

// Or beside the turn once it has landed, in `warn`. What the checks found rides on the loop's next
// tool result, whatever the tool.
export function checkAfter($: EngineInterface, e: ToolCallEvent, ran: ToolCallDone): ToolCallDone {
  if (ran.deny !== undefined) return ran
  const loop = e.agentId ?? MAIN
  const change = changeOf(e)
  if (change && settings.live === 'warn' && !ran.isError) checkInBackground($, loop, change)
  const delivered = takeNotes(loop)
  return delivered.length > 0 ? { ...ran, context: [...(ran.context ?? []), ...delivered] } : ran
}

// The turn's end waits for the checks of its edits, so what they caught is told to Claude and
// looked for again before the turn's diff is read.
export async function endReviewTurn($: EngineInterface, agentId: string | undefined, reason: string) {
  await settleTurn($, agentId, reason).catch(() => {})
  if (agentId === undefined) void afterTurn($).catch(() => {})
}

// Where classic hooks run, they keep the same turn going instead of starting a new one.
export async function classicStop($: Parameters<Hook<'classic.Stop'>>[0], e: Parameters<Hook<'classic.Stop'>>[1], next: Parameters<Hook<'classic.Stop'>>[2]) {
  stopped.add(MAIN)
  const delivered = await settle($, MAIN)
  const result = await next(e)
  if (delivered.length === 0 || e.stop_hook_active || result.block !== undefined) return result
  return { ...result, block: delivered.join('\n\n') }
}

export async function classicSubagentStop($: Parameters<Hook<'classic.SubagentStop'>>[0], e: Parameters<Hook<'classic.SubagentStop'>>[1], next: Parameters<Hook<'classic.SubagentStop'>>[2]) {
  stopped.add(e.agent_id)
  const delivered = await settle($, e.agent_id)
  const result = await next(e)
  if (delivered.length === 0 || e.stop_hook_active || result.block !== undefined) return result
  return { ...result, block: delivered.join('\n\n') }
}

export async function command($: Parameters<MatchedHook<'command.run', { command: 'changes' }>>[0], e: Parameters<MatchedHook<'command.run', { command: 'changes' }>>[1]) {
  const [verb = ''] = e.args.trim().split(/\s+/)
  const w = await wordsIn($)
  if (verb.toLowerCase() === 'rules') {
    const found = await ruleFilesFor($, [])
    const running = [...pending.values()].reduce((n, r) => n + r.size, 0)
    const files = found.length > 0 ? `${w.rulesHere}\n${found.map(f => `  ${f.path}`).join('\n')}` : w.noRulesHere
    return { text: `${w.liveHeader(settings.live, settings.liveModel, running)}\n\n${files}` }
  }
  const hasEdits = (await read($, turnAtom)) !== null || Object.keys(await read($, beforeAtom)).length > 0
  if (!hasEdits && (await read($, modeAtom)) !== 'uncommitted') return { text: w.nothing }
  await openPane($)
  return { text: w.opened }
}

// One row above the prompt: the last turn's edits, what the review found, what is left to look at.
// Red while it found a likely bug, yellow while findings or unseen pieces remain, green otherwise.
// The last turn with edits as the row above the prompt says it, and how many columns that takes:
// what it changed, what the review found, what is left to look at. Pressed, it opens the pane.
export async function reviewLine($: EngineInterface, e: AbovePromptEvent) {
  const turn = await read($, turnAtom)
  if (!turn) return null
  const { Text, Button } = $.ui.resolve(e)
  const w = await wordsIn($)
  const review = (await read($, reviewsAtom))[turn.fingerprint]
  const sent = await read($, sentAtom)
  const dismissed = await read($, dismissedAtom)
  const seen = await read($, seenAtom)
  const findings = [...(review ?? []).filter(f => open(f, sent, dismissed)), ...(await earlierFindings($, turn)), ...(await openCaught($))]
  const bugs = findings.filter(f => f.severity === 'bug').length
  const unseen = turn.files.flatMap(f => f.hunks).filter(hunk => !seen.includes(hunk.id)).length
  const isReviewing = (await read($, busyAtom)).includes('review') && !review
  const isSkipped = !review && !isReviewing && isSmall(turn)
  const added = turn.files.reduce((n, f) => n + f.added, 0)
  const removed = turn.files.reduce((n, f) => n + f.removed, 0)
  const tone = bugs > 0 ? 'error' : findings.length > 0 || unseen > 0 ? 'warning' : 'success'
  const sep = <Text dimColor> · </Text>
  // What the row says, as plain text: the columns it takes.
  const said = [
    `✎ ${w.files(turn.files.length)} +${added} −${removed}`,
    ...(isReviewing ? [w.reviewing] : []),
    ...(isSkipped ? [w.small] : []),
    ...(bugs > 0 ? [w.bugs(bugs)] : []),
    ...(findings.length - bugs > 0 ? [w.findings(findings.length - bugs)] : []),
    ...(unseen > 0 ? [w.unseen(unseen)] : review && findings.length === 0 ? [w.allSeen] : []),
  ].join(' · ')
  const item = (
    <Button key="row-review" plain onPress={() => void openPane($).catch(() => {})}>
      <Text wrap="truncate">
        <Text color={tone}>✎ </Text>
        <Text bold>{w.files(turn.files.length)}</Text>
        <Text>
          {' '}
          <Text color="success">+{added}</Text> <Text color="error">−{removed}</Text>
        </Text>
        {isReviewing ? (
          <Text>
            {sep}
            <Text dimColor>{w.reviewing}</Text>
          </Text>
        ) : null}
        {isSkipped ? (
          <Text>
            {sep}
            <Text dimColor>{w.small}</Text>
          </Text>
        ) : null}
        {bugs > 0 ? (
          <Text>
            {sep}
            <Text color="error">{w.bugs(bugs)}</Text>
          </Text>
        ) : null}
        {findings.length - bugs > 0 ? (
          <Text>
            {sep}
            <Text color="warning">{w.findings(findings.length - bugs)}</Text>
          </Text>
        ) : null}
        {unseen > 0 ? (
          <Text>
            {sep}
            <Text color="warning">{w.unseen(unseen)}</Text>
          </Text>
        ) : review && findings.length === 0 ? (
          <Text>
            {sep}
            <Text color="success">{w.allSeen}</Text>
          </Text>
        ) : null}
      </Text>
    </Button>
  )
  return { item, width: said.length }
}

export async function pane($: Parameters<PaneHook>[0], e: Parameters<PaneHook>[1]) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button, Markdown } = elements
  const Select = 'Select' in elements ? elements.Select : undefined
  const Input = 'Input' in elements ? elements.Input : undefined
  const w = await wordsIn($)
  const diff = await read($, shownAtom)
  const mode = await read($, modeAtom)
  const tab = await read($, tabAtom)
  const busy = await read($, busyAtom)
  const error = await read($, errorAtom)
  const seen = await read($, seenAtom)
  const sent = await read($, sentAtom)
  const dismissed = await read($, dismissedAtom)
  const expanded = await read($, expandedAtom)
  const spent = await read($, spentAtom)
  const files = diff?.files ?? []
  const review = diff ? (await read($, reviewsAtom))[diff.fingerprint] : undefined
  const earlier = await earlierFindings($, diff)
  const caught = await read($, caughtAtom)
  const findings = [...(review ?? []).filter(f => open(f, sent, dismissed)), ...earlier, ...(await openCaught($))]
  const unseen = files.flatMap(f => f.hunks).filter(hunk => !seen.includes(hunk.id)).length
  const label = (t: Tab) =>
    t === 'changes' && unseen > 0 ? `${w.tabs.changes} (${unseen})` : t === 'findings' && findings.length > 0 ? `${w.tabs.findings} (${findings.length})` : w.tabs[t]

  let body
  if (files.length === 0) body = <Text dimColor>{w.emptyMode(mode)}</Text>
  else if (tab === 'changes') {
    const notes = await read($, notesAtom)
    const pickedPath = await read($, fileAtom)
    const picked = files.find(f => f.path === pickedPath) ?? files[0]!
    const root = await $.session.root()
    const project = nameOf(root)
    const hunks = files.flatMap(f => f.hunks)
    const seenCount = hunks.filter(hunk => seen.includes(hunk.id)).length
    const added = files.reduce((n, f) => n + f.added, 0)
    const removed = files.reduce((n, f) => n + f.removed, 0)
    const groups = [...new Set(files.map(f => f.group))]
    const isFileSeen = (f: FileDiff) => f.hunks.every(hunk => seen.includes(hunk.id))
    // The findings on the picked file: by the hunk whose new lines hold them, those with no line
    // above the hunks.
    const onFile = findings.filter(fd => fd.file === picked.shown || fd.file === picked.rel)
    const inHunk = (hunk: Hunk, fd: Finding) =>
      fd.line !== undefined && fd.line >= hunk.newStart && fd.line < hunk.newStart + hunk.lines.filter(l => l.kind !== '-').length
    // Indented by the Box, not by spaces, so a wrapped line keeps the indent.
    const said = (fd: Finding) => (
      <Box paddingLeft={2}>
        <Text color={SEVERITY[fd.severity].color}>{`${SEVERITY[fd.severity].icon} ${w.severity[fd.severity]}: ${fd.text}`}</Text>
      </Box>
    )
    // Each line of code fills the row, so its colour reads as a bar, as Claude Code's own diff.
    const width = Math.max(20, e.props.bodyColumns - GUTTER)
    const pad = (text: string) => (text.length >= width ? text : text + ' '.repeat(width - text.length))
    const nextUnseen = (after: FileDiff) => files.find(f => f !== after && !isFileSeen(f)) ?? after
    body = (
      <Box flexDirection="column">
        {diff?.request ? (
          <Text dimColor wrap="truncate">
            {`${w.request} ${diff.request.replace(/\s+/g, ' ')}`}
          </Text>
        ) : null}
        <Text>
          <Text bold>{w.files(files.length)}</Text>
          <Text dimColor> · </Text>
          <Text color="success">+{added}</Text> <Text color="error">−{removed}</Text>
          <Text dimColor> · </Text>
          <Text color={seenCount === hunks.length ? 'success' : 'warning'}>{w.seenOf(seenCount, hunks.length)}</Text>
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {groups.map(g => (
            <Box flexDirection="column">
              <Text bold color="claude">
                {g === '' ? project : g}
              </Text>
              {files
                .filter(f => f.group === g)
                .map(f => {
                  const i = files.indexOf(f)
                  const isPicked = f.path === picked.path
                  return (
                    <Box flexDirection="row" gap={1}>
                      <Text bold>{isPicked ? '▸' : ' '}</Text>
                      <Text color={isFileSeen(f) ? 'success' : 'warning'}>{isFileSeen(f) ? '✓' : '●'}</Text>
                      <Box flexShrink={1}>
                        <Button key={`file-${i}`} label={f.rel} plain {...(isPicked ? {} : { dimColor: true })} onPress={() => void update($, fileAtom, () => f.path)} />
                      </Box>
                      <Box flexDirection="row" gap={1} flexShrink={0}>
                        {f.isNew ? <Text color="success">{w.newFile}</Text> : f.isDeleted ? <Text color="error">{w.deletedFile}</Text> : null}
                        <Text>
                          <Text color="success">+{f.added}</Text> <Text color="error">−{f.removed}</Text>
                        </Text>
                      </Box>
                    </Box>
                  )
                })}
            </Box>
          ))}
        </Box>
        {busy.includes('notes') ? (
          <Box marginTop={1}>
            <Text dimColor>{w.explaining}</Text>
          </Box>
        ) : null}
        {onFile.some(fd => fd.line === undefined) ? (
          <Box flexDirection="column" marginTop={1}>
            {onFile.filter(fd => fd.line === undefined).map(said)}
          </Box>
        ) : null}
        {picked.hunks.map(hunk => {
          const isSeen = seen.includes(hunk.id)
          const isSent = sent.includes(hunk.id)
          const limit = expanded[hunk.id] ?? HUNK_LINES
          const lines = hunk.lines.slice(0, limit)
          const rest = hunk.lines.length - lines.length
          const step = Math.min(rest, HUNK_STEP)
          const spans = pairedSpans(lines)
          let oldNo = hunk.oldStart
          let newNo = hunk.newStart
          return (
            <Box flexDirection="column" marginTop={1}>
              <Box flexDirection="row" gap={1}>
                <Text color={isSeen ? 'success' : 'warning'}>{isSeen ? '✓' : '●'}</Text>
                <Box flexGrow={1} flexShrink={1}>
                  <Text bold wrap="truncate">{`${picked.rel}:${hunk.newStart}`}</Text>
                </Box>
                <Box key={`actions-${hunk.id}`} flexDirection="row" gap={1} flexShrink={0}>
                  {isSeen ? null : <Button key={`seen-${hunk.id}`} label={w.markSeen} onPress={() => void markSeen($, [hunk.id]).catch(() => {})} />}
                  <Button
                    key={`ask-${hunk.id}`}
                    label={w.askAbout}
                    dimColor
                    onPress={() =>
                      void (async () => {
                        await update($, askAboutAtom, () => hunk.id)
                        await update($, tabAtom, () => 'ask')
                      })().catch(() => {})
                    }
                  />
                  {isSent ? (
                    <Text dimColor>{w.sentToClaude}</Text>
                  ) : (
                    <Button key={`revert-${hunk.id}`} label={w.revert} dimColor onPress={() => void revertHunk($, picked, hunk).catch(() => {})} />
                  )}
                </Box>
              </Box>
              {notes[hunk.id] ? (
                <Box paddingLeft={2}>
                  <Text color="suggestion" italic>
                    {notes[hunk.id]}
                  </Text>
                </Box>
              ) : null}
              {onFile.filter(fd => inHunk(hunk, fd)).map(said)}
              {lines.map((l, k) => {
                const gutter = `${l.kind === '+' ? '' : String(oldNo)}`.padStart(4) + ' ' + `${l.kind === '-' ? '' : String(newNo)}`.padStart(4) + ' '
                if (l.kind !== '+') oldNo++
                if (l.kind !== '-') newNo++
                const span = spans[k]
                return (
                  <Text wrap="truncate">
                    <Text dimColor>{gutter}</Text>
                    {l.kind === ' ' ? (
                      <Text dimColor>{`  ${l.text}`}</Text>
                    ) : span ? (
                      <Text backgroundColor={l.kind === '+' ? 'diffAdded' : 'diffRemoved'}>
                        {`${l.kind} ${span.head}`}
                        <Text backgroundColor={l.kind === '+' ? 'diffAddedWord' : 'diffRemovedWord'}>{l.kind === '+' ? span.now : span.was}</Text>
                        {pad(`${l.kind} ${span.head}${l.kind === '+' ? span.now : span.was}${span.tail}`).slice(`${l.kind} ${span.head}${l.kind === '+' ? span.now : span.was}`.length)}
                      </Text>
                    ) : (
                      <Text backgroundColor={l.kind === '+' ? 'diffAdded' : 'diffRemoved'}>{pad(`${l.kind} ${l.text}`)}</Text>
                    )}
                  </Text>
                )
              })}
              {/* A long hunk is cut, and opened further on a press: the rest is read in the pane. */}
              {rest > 0 || limit > HUNK_LINES ? (
                <Box flexDirection="row" gap={2}>
                  {rest > 0 ? (
                    <Button
                      key={`more-${hunk.id}`}
                      label={w.showMore(step, step === rest)}
                      plain
                      onPress={() => void update($, expandedAtom, e => ({ ...e, [hunk.id]: limit + step })).catch(() => {})}
                    >
                      <Text dimColor>{`${' '.repeat(GUTTER)}${w.moreLines(rest)} · `}</Text>
                      <Text color="suggestion">{w.showMore(step, step === rest)}</Text>
                    </Button>
                  ) : null}
                  {limit > HUNK_LINES ? (
                    <Button
                      key={`less-${hunk.id}`}
                      label={w.showLess}
                      plain
                      dimColor
                      onPress={() =>
                        void update($, expandedAtom, e => {
                          const { [hunk.id]: _dropped, ...others } = e
                          return others
                        }).catch(() => {})
                      }
                    >
                      {rest > 0 ? w.showLess : `${' '.repeat(GUTTER)}${w.showLess}`}
                    </Button>
                  ) : null}
                </Box>
              ) : null}
            </Box>
          )
        })}
        {seenCount < hunks.length ? (
          <Box marginTop={1} flexDirection="row" flexWrap="wrap" columnGap={1}>
            {!isFileSeen(picked) ? (
              <Button
                key="seen-file"
                label={w.markFileSeen}
                hotkey="s"
                onPress={() =>
                  void (async () => {
                    await markSeen($, picked.hunks.map(hunk => hunk.id))
                    await update($, fileAtom, () => nextUnseen(picked).path)
                  })().catch(() => {})
                }
              />
            ) : null}
            {/* With one file it would say what the file's own button says. */}
            {files.length > 1 ? (
              <Button key="seen-all" label={w.markAllSeen} hotkey="a" onPress={() => void markSeen($, hunks.map(hunk => hunk.id)).catch(() => {})} />
            ) : null}
          </Box>
        ) : null}
      </Box>
    )
  } else if (tab === 'findings') {
    const all = review ?? []
    const item = (f: Finding & { evidence?: string }) => {
      const isSent = sent.includes(f.id)
      const isDismissed = dismissed.includes(f.id)
      const isDone = isSent || isDismissed
      return (
        <Box flexDirection="column" marginTop={1}>
          {/* Only the path gives way to a narrow pane: the kind and the buttons keep their width,
              or each would break across lines, a word or a bracket to a row. */}
          <Box flexDirection="row" gap={1}>
            <Box flexDirection="row" gap={1} flexShrink={0}>
              <Text color={isDone ? 'inactive' : SEVERITY[f.severity].color}>{SEVERITY[f.severity].icon}</Text>
              <Text bold color={isDone ? 'inactive' : SEVERITY[f.severity].color}>
                {w.severity[f.severity]}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text bold wrap="truncate" {...(isDone ? { dimColor: true } : {})}>
                {findingAt(f)}
              </Text>
            </Box>
            <Box key={`actions-${f.id}`} flexDirection="row" gap={1} flexShrink={0}>
              <Button key={`code-${f.id}`} label={w.toCode} dimColor onPress={() => void goToCode($, f).catch(() => {})} />
              {isSent ? (
                <Text dimColor>{w.sentToClaude}</Text>
              ) : isDismissed ? (
                <Text dimColor>{w.putAside}</Text>
              ) : (
                <>
                  <Button key={`fix-${f.id}`} label={w.fix} onPress={() => void fixFinding($, f).catch(() => {})} />
                  <Button key={`dismiss-${f.id}`} label={w.notABug} dimColor onPress={() => void update($, dismissedAtom, d => [...d, f.id])} />
                </>
              )}
            </Box>
          </Box>
          <Box flexDirection="column" paddingLeft={2}>
            <Text {...(isDone ? { dimColor: true } : {})}>{f.text}</Text>
            {f.evidence ? <Text dimColor>{w.found(f.evidence)}</Text> : null}
            {f.rule ? (
              <Text dimColor italic>
                {w.ruleFrom(f.rule)}
              </Text>
            ) : null}
          </Box>
        </Box>
      )
    }
    body = (
      <Box flexDirection="column">
        <Text dimColor>{w.findingsNote}</Text>
        {busy.includes('review') && !review ? (
          <Text dimColor>{w.reviewing}</Text>
        ) : !review ? (
          <Text dimColor>{diff && diff.mode === 'turn' && isSmall(diff) ? w.smallNote : w.notReviewed}</Text>
        ) : all.length === 0 ? (
          <Text color="success">{w.noFindings}</Text>
        ) : (
          all.map(item)
        )}
        {/* What earlier reviews found and nobody has answered yet: a later diff does not drop it. */}
        {earlier.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{w.earlier}</Text>
            {earlier.map(item)}
          </Box>
        ) : null}
        {/* What the check of each edit caught: still in the code, a finding as any other; else
            where it stands, yellow while Claude has it, green once gone. */}
        {caught.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{w.caught}</Text>
            {caught.map(c =>
              c.state === 'open' ? (
                item(c)
              ) : (
                <Box key={`caught-${c.id}`} flexDirection="row" gap={1}>
                  <Text color={c.state === 'fixed' ? 'success' : c.state === 'told' ? 'warning' : 'inactive'}>{c.state === 'fixed' ? '✓' : c.state === 'told' ? '●' : '·'}</Text>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="truncate">{`${findingAt(c)} · ${c.rule ?? c.text}`}</Text>
                  </Box>
                  <Box flexShrink={0}>
                    <Text color={c.state === 'fixed' ? 'success' : c.state === 'told' ? 'warning' : 'inactive'}>{w.caughtState[c.state]}</Text>
                  </Box>
                </Box>
              ),
            )}
          </Box>
        ) : null}
        {findings.length > 1 ? (
          <Box marginTop={1}>
            <Button key="fix-all" label={w.fixAll(findings.length)} hotkey="f" variant="primary" onPress={() => void fixAll($, findings).catch(() => {})} />
          </Box>
        ) : null}
        {!review && !busy.includes('review') && diff ? (
          <Box marginTop={1}>
            <Button key="check" label={w.check} hotkey="r" variant="primary" onPress={() => void reviewDiff($, diff).catch(() => {})} />
          </Box>
        ) : null}
      </Box>
    )
  } else if (tab === 'walkthrough') {
    const text = diff ? (await read($, walkthroughsAtom))[diff.fingerprint] : undefined
    body = (
      <Box flexDirection="column">
        {busy.includes('walkthrough') ? <Text dimColor>{w.walking}</Text> : null}
        {text ? <Markdown text={text} /> : null}
        {text && !busy.includes('walkthrough') ? (
          <Box marginTop={1}>
            <Button key="walk-again" label={w.remake} hotkey="g" dimColor onPress={() => void walkThrough($, true).catch(() => {})} />
          </Box>
        ) : null}
      </Box>
    )
  } else {
    const about = hunkOf(diff, await read($, askAboutAtom))
    const answer = await read($, answerAtom)
    body = (
      <Box flexDirection="column">
        {about ? (
          <Box flexDirection="row" gap={1}>
            <Text>{w.askAboutHunk(whereOf(about.f, about.hunk))}</Text>
            <Button key="forget-hunk" label={w.forget} dimColor onPress={() => void update($, askAboutAtom, () => null)} />
          </Box>
        ) : null}
        {Input ? <Input key="question" placeholder={w.askPlaceholder} submitLabel={w.ask} autoFocus onSubmit={value => void ask($, value).catch(() => {})} /> : null}
        {busy.includes('answer') ? <Text dimColor>{w.walking}</Text> : null}
        {answer ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{answer.question}</Text>
            <Markdown text={answer.text} />
          </Box>
        ) : null}
      </Box>
    )
  }

  // The ring starts on the open tab, so the arrows walk the tabs and the buttons; on Ask the
  // question field takes it. The diff's mode comes last, out of the arrows' way.
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {TABS.map((t, i) => (
          <Button
            key={`tab-${t}`}
            label={label(t)}
            hotkey={String(i + 1)}
            variant={t === tab ? 'primary' : 'secondary'}
            {...(t === tab && tab !== 'ask' ? { autoFocus: true as const } : {})}
            onPress={() => void openTab($, t).catch(() => {})}
          />
        ))}
      </Box>
      {error ? <Text color="error">{error}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {body}
      </Box>
      {Select ? (
        <Box marginTop={1}>
          <Select key="mode" label={w.mode} value={mode} options={MODES.map(m => ({ value: m, label: w.modes[m] }))} onSelect={value => void setMode($, value as Mode).catch(() => {})} />
        </Box>
      ) : null}
      {spent.calls > 0 ? <Text dimColor>{w.spent(spent)}</Text> : null}
    </Box>
  )
}
