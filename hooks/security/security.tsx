import { atom, read, update } from 'claude-code'
import type { EngineInterface, Hook, PluginOptions } from 'claude-code'

import type { SecurityFinding, SecurityLogEntry, SecurityRefused, SecurityReview } from '../../types'
import type { PaneHook } from '../core/hooks'
import { langIn } from '../core/lang'
import { nestedRepos } from '../core/repos'
import { isOn } from '../parts/parts'
import { below, canonical, joinPath, parseStatus } from '../review/diff'
import { EVIDENCE_LIMIT, parseSecurityReport } from './report'
import { findSecrets, findSinks, isCode, isTest, isReadOnlyCommand, redact } from './scan'
import type { SecretHit } from './scan'
import { EDIT_SYSTEM, WORDS } from './words'

// The watch over the code the agent writes. Before it works: the short rules, with the prompt.
// Before each edit lands: a secret by its known shape is refused, in an edit or a shell command, and
// a small model refuses a hole it can see. After the turn: an agent that made none of it reads what
// changed across files, and what can be attacked now goes back to Claude. What each of them stopped
// or found goes in a journal, /security shows. /security audit tests the whole project by its source,
// with no network: its agent is refused every tool that reaches one.

type CallEvent = Parameters<Hook<'tool.call'>>[1]
type CallDone = Awaited<ReturnType<Parameters<Hook<'tool.call'>>[2]>>
type Origin = Parameters<Hook<'prompt.submit'>>[1]['origin']

const reviewAtom = atom({ plugin: 'agent-lens', key: 'security.review' } as const, null)
const refusedAtom = atom({ plugin: 'agent-lens', key: 'security.refused' } as const, [])
const logAtom = atom({ plugin: 'agent-lens', key: 'security.log' } as const, [])
// What the person chose on the pane or by /security agent: it stands over the setting, across sessions
// and for every project. In an atom, so the pane redraws by it.
const modeAtom = atom({ plugin: 'agent-lens', key: 'security.mode' } as const, null)
// The tools the watch's own agents may use: what reads local files, and nothing else.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])
const mayRead = (e: CallEvent) => READ_TOOLS.has(e.tool) || (e.tool === 'Bash' && isReadOnlyCommand(e.command))

const logKey = (root: string) => `security:log:${root}`
const MODE_KEY = 'security:agent-mode'

export const PANE = 'agent-lens-security'
const COMMAND = 'security'
const MAIN = 'main'
const HEAD = 'HEAD'
// The agent reads data flow across files: more than the haiku of each edit can.
const DEFAULT_MODEL = 'sonnet'
const DEFAULT_CHECK_MODEL = 'haiku'
// A run past this is taken as gone: another may start.
const STALE_MS = 30 * 60_000
// How many times in a row findings go back to Claude by themselves, so a false alarm Claude rejects
// does not go round for good. A word of the person's starts the count over.
const ROUNDS = 3
const FILES_LIMIT = 100
const TOLD_LIMIT = 30
const HINTS_LIMIT = 30
const REFUSED_LIMIT = 20
const LOG_LIMIT = 200
const LOG_SHOWN = 30
// A check before writing: how long an edit may wait for it, how much of the file it is shown, and how
// many times one file is refused in a turn before it goes through, for the person to judge: the check
// sees little, and may be wrong.
const CHECK_TIMEOUT_MS = 20_000
const CHECK_FILE_LIMIT = 12_000
const CHECK_CHANGE_LIMIT = 20_000
const REFUSALS = 2

type Mode = 'auto' | 'button'
let settings: { mode: Mode; model: string; isChecking: boolean; checkModel: string } = { mode: 'auto', model: DEFAULT_MODEL, isChecking: true, checkModel: DEFAULT_CHECK_MODEL }
const modeOf = (value: unknown): Mode | undefined => (value === 'auto' || value === 'button' ? value : undefined)

// One repository as the first shell command found it: a command may commit, so what it changed is
// told from this commit and these files, and the agent reads from this commit.
type Snapshot = { repo: string; head: string; dirty: ReadonlySet<string> }

// What this conversation keeps here: the files changed and not read yet, a turn cut short keeping
// them for the next; the repositories as the first shell command found them; the secrets the person
// let through; what a file was before a Write of it, by call; the risky lines seen, for the agent to
// start from; the loops told the rules; files waiting for a run under way; the agents started; the
// findings told to Claude, not to be raised again; and the rounds in a row.
const edited = new Set<string>()
const refusals = new Map<string, number>()
// The calls the check before writing answered for: a pattern's note on them would only repeat it.
const judged = new Set<string>()
let isFailureTold = false
let snapshot: Promise<Snapshot[]> | null = null
const allowed = new Set<string>()
const written = new Map<string, string>()
let hints: string[] = []
const rulesTold = new Set<string>()
let queued: string[] = []
let queuedBases: Record<string, string> = {}
const agents = new Set<string>()
const others = new Set<string>()
let told: string[] = []
let rounds = 0

async function modeIn($: EngineInterface) {
  return (await read($, modeAtom)) ?? settings.mode
}

async function wordsIn($: EngineInterface) {
  return WORDS[await langIn($)]
}

export function configureSecurity(options: PluginOptions) {
  const model = typeof options.securityModel === 'string' && options.securityModel.trim() !== '' ? options.securityModel.trim() : DEFAULT_MODEL
  const checkModel = typeof options.securityCheckModel === 'string' && options.securityCheckModel.trim() !== '' ? options.securityCheckModel.trim() : DEFAULT_CHECK_MODEL
  settings = { mode: options.securityAgent === 'button' ? 'button' : 'auto', model, isChecking: options.securityCheck !== 'off', checkModel }
}

export async function registerCommand($: EngineInterface) {
  await $.command.register({ name: COMMAND, description: (await wordsIn($)).description, argumentHint: '[audit|run|allow|clear|agent auto|agent button]' })
}

// A /clear or /resume: nothing of the conversation before is carried on.
export async function clearSecurity($: EngineInterface) {
  edited.clear()
  refusals.clear()
  judged.clear()
  isFailureTold = false
  snapshot = null
  allowed.clear()
  written.clear()
  hints = []
  rulesTold.clear()
  queued = []
  queuedBases = {}
  told = []
  rounds = 0
  await update($, reviewAtom, () => null)
  await update($, refusedAtom, () => [])
}

// The store holds the journal of each project, the value what the pane shows. Writes go one after
// another, each from what the store holds, so none is lost to another or to a /clear reading it back;
// a read that fails changes nothing, and the journal is not written over from what is in memory.
let logQueue: Promise<unknown> = Promise.resolve()

export async function restoreSecurity($: EngineInterface) {
  // A read that fails changes nothing, as with the journal below.
  const saved = await $.store.get(MODE_KEY).catch(() => null)
  if (saved !== null) await update($, modeAtom, () => modeOf(saved) ?? null)
  const reading = logQueue.then(async () => {
    const kept = (await $.store.get(logKey(await $.session.root()))) as SecurityLogEntry[] | undefined
    await update($, logAtom, () => kept ?? [])
  })
  logQueue = reading.catch(() => {})
  await logQueue
}

// Written down at once and kept: the same thing tried again, in a row, is counted on its entry.
async function logTried($: EngineInterface, entries: readonly Omit<SecurityLogEntry, 'at'>[]) {
  if (entries.length === 0) return
  const writing = logQueue.then(async () => {
    const at = await $.clock.now()
    const key = logKey(await $.session.root())
    const kept = (await $.store.get(key).catch(() => null)) as SecurityLogEntry[] | undefined | null
    let all: SecurityLogEntry[] = kept ?? (kept === null ? await read($, logAtom) : [])
    for (const entry of entries) {
      const head = all[0]
      const isAgain = head && head.by === entry.by && head.outcome === entry.outcome && head.kind === entry.kind && head.file === entry.file && head.problem === entry.problem
      all = isAgain ? [{ ...head, at, times: (head.times ?? 1) + 1 }, ...all.slice(1)] : [{ ...entry, at }, ...all]
    }
    all = all.slice(0, LOG_LIMIT)
    await update($, logAtom, () => all)
    if (kept !== null) await $.store.set(key, all)
  })
  logQueue = writing.catch(() => {})
  await logQueue
}

const whenOf = (at: number) => new Date(at).toLocaleString('sv').slice(5, 16)

const logHead = (w: (typeof WORDS)['en'], entry: SecurityLogEntry) =>
  `${whenOf(entry.at)} · ${w.outcome[entry.outcome]}${entry.times ? ` ×${entry.times}` : ''} · ${entry.kind} · ${entry.file === SHELL ? w.inShell : entry.file}${entry.line ? `:${entry.line}` : ''}`

const logOf = (f: SecurityFinding, by: SecurityLogEntry['by'], outcome: SecurityLogEntry['outcome']): Omit<SecurityLogEntry, 'at'> => ({
  by,
  outcome,
  kind: f.kind,
  file: f.file,
  ...(f.line ? { line: f.line } : {}),
  problem: f.problem,
  ...(f.fix ? { fix: f.fix } : {}),
  ...(f.evidence ? { evidence: f.evidence } : {}),
})

// The rules go with the first prompt, so Claude has them before its first line, and again after a
// compaction. A subagent has no such prompt: its first edit carries them.
export async function securityRules($: EngineInterface) {
  if (rulesTold.has(MAIN)) return undefined
  rulesTold.add(MAIN)
  return (await wordsIn($)).rules
}

// A compaction takes the rules out of what Claude reads: they go again with the next prompt.
export function compactSecurity() {
  rulesTold.clear()
}

// Whether a person sent this, not a plugin or an agent: only a person may let a secret through.
export const isPersons = (origin: Origin | undefined) => origin?.kind === 'composer' || origin?.kind === 'bridge' || origin?.kind === 'sdk'

export function personSpoke() {
  rounds = 0
}

async function gitOut($: EngineInterface, repo: string, args: string[]) {
  const r = await $.process.run(['git', '-c', 'core.quotePath=false', '-C', repo, ...args], { cwd: repo, timeoutMs: 15_000 }).catch(() => null)
  return r?.exitCode === 0 ? r.stdout : null
}

async function reposOf($: EngineInterface) {
  const root = await $.session.root()
  return [root, ...(await nestedRepos($, root))]
}

// Every file uncommitted in a repository, by path; null where it is no repository or git failed.
async function uncommittedIn($: EngineInterface, repo: string) {
  const out = await gitOut($, repo, ['status', '--porcelain', '-z', '--untracked-files=all'])
  return out === null ? null : parseStatus(out).map(rel => joinPath(repo, rel))
}

async function takeSnapshot($: EngineInterface): Promise<Snapshot[]> {
  const taken = await Promise.all(
    (await reposOf($)).map(async (repo): Promise<Snapshot | null> => {
      const dirty = await uncommittedIn($, repo)
      const head = await gitOut($, repo, ['rev-parse', HEAD])
      return dirty === null ? null : { repo, head: head?.trim() ?? HEAD, dirty: new Set(dirty) }
    }),
  )
  return taken.filter((s): s is Snapshot => s !== null)
}

// What the shell changed since the snapshot: left uncommitted, or committed.
async function changedSince($: EngineInterface, snap: Snapshot) {
  const now = (await uncommittedIn($, snap.repo)) ?? []
  const committed = snap.head === HEAD ? null : await gitOut($, snap.repo, ['diff', '--name-only', '-z', snap.head, HEAD])
  return [...now.filter(path => !snap.dirty.has(path)), ...(committed ?? '').split('\0').filter(Boolean).map(rel => joinPath(snap.repo, rel))]
}

// A path git ignores is where a secret belongs: `.env`, not the code.
async function isIgnored($: EngineInterface, path: string) {
  const dir = path.replace(/[\\/][^\\/]*$/, '') || '.'
  const r = await $.process.run(['git', '-C', dir, 'check-ignore', '-q', path], { cwd: dir, timeoutMs: 5_000 }).catch(() => null)
  return r?.exitCode === 0
}

// What a call writes, and to which file: undefined for a tool that writes nothing.
const fileWrite = (e: CallEvent): { path: string; text: string; before: string } | undefined =>
  e.tool === 'Edit' ? { path: e.file_path, text: e.new_string, before: e.old_string }
  : e.tool === 'Write' ? { path: e.file_path, text: e.content, before: '' }
  : e.tool === 'NotebookEdit' ? { path: e.notebook_path, text: e.new_source ?? '', before: '' }
  : undefined

// Said to Claude, in English whatever the language, as the review's notes are.
const refusalFor = (where: string, hits: readonly SecretHit[]) =>
  `agent-lens refused this: it puts a credential in ${where === SHELL ? 'a shell command' : where}, where it could be committed or sent out.
${hits.map(hit => `- ${hit.kind}: ${hit.masked}`).join('\n')}
Read it from the environment or a secret store, and keep the value in a file git ignores (.env). If the person really wants this value here, stop and ask them to run /security allow; trying again will not pass.`

const SHELL = 'shell'

// Whether a subagent is the watch's: named by this module, or by its task where it calls a tool
// before the spawn has named it here.
async function isOwnAgent($: EngineInterface, agentId: string) {
  if (agents.has(agentId)) return true
  if (others.has(agentId)) return false
  const listed = await $.agent.list().catch(() => undefined)
  const agent = listed?.find(a => a.id === agentId)
  if (agent?.spawnedBy === 'agent-lens' && (agent.description === WORDS.en.task || agent.description === WORDS.ru.task)) {
    agents.add(agentId)
    return true
  }
  // A list that failed tells nothing: the next call asks again.
  if (listed) others.add(agentId)
  return false
}

// One edit before it lands: a hole the small model can see in it refuses it. A check that fails lets
// the edit be, and says so: the agent still reads it after the turn. A file refused twice in a turn
// with no clean edit between goes through on the third try, in the journal and on the pane for the
// person: counted by file, as the model may name one hole in other words each time.
async function checkEdit($: EngineInterface, e: CallEvent, shown: string, { path, text, before }: { path: string; text: string; before: string }) {
  const clip = (t: string, limit: number) => {
    const safe = redact(t)
    return safe.length > limit ? `${safe.slice(0, limit)}\n[...]` : safe
  }
  const flagged = findSinks(shown, text, before).map(s => `- ${s.kind}: ${s.text}`)
  const around = e.tool === 'Edit' ? await $.fs.read(path).catch(() => '') : ''
  const r = await $.model.complete({
    model: settings.checkModel,
    system: (await langIn($)) === 'ru' ? `${EDIT_SYSTEM}\nWrite "problem" and "fix" in Russian.` : EDIT_SYSTEM,
    prompt: [
      {
        text: `File: ${shown}\n${around ? `\nThe file as it is now:\n<<<\n${clip(around, CHECK_FILE_LIMIT)}\n>>>\n` : ''}${before && e.tool === 'Edit' ? `\nThe edit takes out:\n<<<\n${clip(before, CHECK_CHANGE_LIMIT)}\n>>>\n` : ''}\nThe NEW text:\n<<<\n${clip(text, CHECK_CHANGE_LIMIT)}\n>>>${flagged.length > 0 ? `\n\nLines a pattern flagged, which may well be safe:\n${flagged.join('\n')}` : ''}`,
      },
    ],
    maxTokens: 1024,
    effort: 'low',
    timeoutMs: CHECK_TIMEOUT_MS,
  }).catch(() => undefined) // a model the engine will not call: a check that failed like any other
  const report = r?.isAnswered ? parseSecurityReport(r.text, shown) : undefined
  if (!report) {
    if (!isFailureTold) await $.ui.toast((await wordsIn($)).checkFailed)
    isFailureTold = true
    return undefined
  }
  if (e.tool_use_id) judged.add(e.tool_use_id)
  const file = canonical(path)
  const found = report.findings.filter(f => f.severity === 'high').map(f => ({ ...f, file: shown }))
  if (found.length === 0) {
    refusals.delete(file)
    return undefined
  }
  const tries = refusals.get(file) ?? 0
  if (tries >= REFUSALS) {
    refusals.delete(file)
    await update($, reviewAtom, (cur): SecurityReview => (cur ? { ...cur, findings: [...found, ...cur.findings] } : { status: 'done', at: 0, files: [shown], findings: found, checked: '' }))
    await logTried($, found.map(f => logOf(f, 'edit', 'passed')))
    await $.ui.toast((await wordsIn($)).letThrough(shown))
    return undefined
  }
  refusals.set(file, tries + 1)
  await logTried($, found.map(f => logOf(f, 'edit', 'refused')))
  await $.ui.toast((await wordsIn($)).band(found.length))
  return `agent-lens refused this edit to ${shown}: it would open a security hole.\n${found.map(f => `- ${f.kind}: ${f.problem}${f.evidence ? `\n  found: ${f.evidence}` : ''}${f.fix ? `\n  fix: ${f.fix}` : ''}`).join('\n')}\nWrite it safely instead. Do not leave it for later.`
}

// Before any tool runs: a new secret is refused until the person lets it through. No number of tries
// passes it, or the refusal would only teach Claude to try again. Once one is found the refusal
// stands, whatever becomes of showing it.
export async function securityBefore($: EngineInterface, e: CallEvent) {
  // The watch's own agents work from the source: the network is shut to them here, not only in words.
  if (e.agentId !== undefined && (await isOwnAgent($, e.agentId)) && !mayRead(e)) return (await wordsIn($)).auditNetwork
  // The part turned off still holds an agent it started to what it was told: only the rest stops.
  if (!isOn('security')) return undefined
  // The watch's own agent only reads: its git is no change of the work.
  const isOwn = e.agentId !== undefined && agents.has(e.agentId)
  if (e.tool === 'Bash' && !isOwn && (await modeIn($)) === 'auto') snapshot ??= takeSnapshot($).catch(() => [])
  if (e.tool === 'Bash') await snapshot
  const file = fileWrite(e)
  if (!file && e.tool !== 'Bash') return undefined
  let before = file?.before ?? ''
  const isWhole = e.tool === 'Write' || e.tool === 'NotebookEdit'
  if (isWhole && file) before = await $.fs.read(file.path).catch(() => '')
  const where = file?.path ?? SHELL
  const hits = findSecrets(file?.text ?? (e.tool === 'Bash' ? e.command : ''), before).filter(hit => !allowed.has(hit.key))
  if (hits.length === 0 || (file && (await isIgnored($, file.path)))) {
    if (e.tool === 'Write' && e.tool_use_id) written.set(e.tool_use_id, before)
    const shown = file && below(file.path, await $.session.root())
    if (!file || shown === undefined || !settings.isChecking || file.text.trim() === '' || !isCode(shown) || isTest(shown)) return undefined
    // A file git ignores is the person's own: it may hold values of no known shape, and stays home.
    if (await isIgnored($, file.path)) return undefined
    return await checkEdit($, e, shown, { ...file, before }).catch(() => undefined)
  }
  const refused: SecurityRefused[] = hits.map(hit => ({ kind: hit.kind, masked: hit.masked, key: hit.key, where }))
  await logTried($, hits.map(hit => ({ by: 'secret' as const, outcome: 'refused' as const, kind: hit.kind, file: where, problem: hit.masked }))).catch(() => {})
  await update($, refusedAtom, all => [...refused, ...all.filter(r => !hits.some(hit => hit.key === r.key))].slice(0, REFUSED_LIMIT)).catch(() => {})
  await wordsIn($)
    .then(w => $.ui.toast(w.refusedToast(hits.length)))
    .catch(() => {})
  return refusalFor(where, hits)
}

// Once a call ran: what it wrote is the turn's, and its risky calls and the rules ride on its result.
export async function securityAfter($: EngineInterface, e: CallEvent, ran: CallDone): Promise<CallDone> {
  const was = e.tool_use_id ? written.get(e.tool_use_id) : undefined
  if (e.tool_use_id) written.delete(e.tool_use_id)
  const isJudged = e.tool_use_id ? judged.delete(e.tool_use_id) : false
  const file = fileWrite(e)
  if (ran.deny !== undefined || ran.isError || !file) return ran
  // A file outside the project is not the project's code: a secret there is still refused above.
  const shown = below(file.path, await $.session.root())
  if (shown === undefined) return ran
  // A file git ignores is the person's own, and goes to no model: see securityBefore.
  if (isCode(shown) && (await isIgnored($, file.path))) return ran
  edited.add(canonical(file.path))
  const notes: string[] = []
  const sinks = findSinks(shown, file.text, was ?? file.before)
  if (sinks.length > 0) hints = [...hints, ...sinks.map(s => `${shown}: ${s.kind}: ${s.text}`)].slice(-HINTS_LIMIT)
  if (sinks.length > 0 && !isJudged) {
    await logTried($, sinks.map(s => ({ by: 'pattern' as const, outcome: 'noted' as const, kind: s.kind, file: shown, problem: s.advice, evidence: s.text.slice(0, EVIDENCE_LIMIT) }))).catch(() => {})
    notes.push(`agent-lens: check these lines you just wrote in ${file.path}; each is safe only where its input cannot be an attacker's.\n${sinks.map(s => `- ${s.kind}: ${s.text}\n  ${s.advice}`).join('\n')}`)
  }
  const loop = e.agentId ?? MAIN
  if (!rulesTold.has(loop) && isCode(shown) && !isTest(shown)) {
    rulesTold.add(loop)
    notes.unshift((await wordsIn($)).rules)
  }
  return notes.length === 0 ? ran : { ...ran, context: [...(ran.context ?? []), ...notes] }
}

// The paths worth the agent's look: code of the project, not its docs or tests.
const codeIn = (paths: readonly string[], root: string) =>
  paths.filter(path => {
    const shown = below(path, root)
    return shown !== undefined && isCode(shown) && !isTest(shown)
  })

// The main loop's turn ended: what changed is read in the background. A turn cut short keeps its
// files for the next. Docs, tests and files outside the project alone start no agent.
export async function endSecurityTurn($: EngineInterface, reason: string) {
  // A call another check refused never reached the end that takes its copy.
  written.clear()
  judged.clear()
  refusals.clear()
  isFailureTold = false
  const mode = await modeIn($)
  if (mode !== 'auto') edited.clear()
  if (reason !== 'answer' || mode !== 'auto') return
  // Taken before the wait: a command of the next turn starts a snapshot of its own.
  const taking = snapshot
  snapshot = null
  const snaps = (await taking) ?? []
  const files = new Set(edited)
  edited.clear()
  for (const snap of snaps) for (const path of await changedSince($, snap).catch(() => [])) files.add(canonical(path))
  const code = codeIn([...files], await $.session.root())
  if (code.length > 0) await readFiles($, code, Object.fromEntries(snaps.map(s => [s.repo, s.head])))
}

const isRunning = (review: SecurityReview | null, at: number) => review?.status === 'running' && at - review.at < STALE_MS
const unsent = (review: SecurityReview | null) => review?.findings.filter(f => !f.isSent) ?? []
const isSame = (a: SecurityFinding, b: SecurityFinding) => a.file === b.file && a.problem === b.problem

// One run at a time, the slot taken in the one write that also looks: files that come while one reads
// wait for its end. What the last run found and was not sent stays. `bases`: the commit to read each
// repository from, where the turn's shell may have committed.
async function readFiles($: EngineInterface, files: readonly string[], bases: Record<string, string> = {}, isAudit = false) {
  const at = await $.clock.now()
  const root = await $.session.root()
  const shown = files.map(path => below(path, root) ?? path)
  let was: SecurityReview | null = null
  let isTaken = false
  await update($, reviewAtom, (cur): SecurityReview | null => {
    if (isRunning(cur, at)) return cur
    was = cur
    isTaken = true
    return { status: 'running', at, files: shown, findings: unsent(cur), checked: '', ...(isAudit ? { isAudit: true as const } : {}) }
  })
  if (!isTaken && isAudit) return { isStarted: false }
  if (!isTaken) {
    queued = [...new Set([...queued, ...files])]
    queuedBases = { ...bases, ...queuedBases }
    return { isStarted: false }
  }
  const isOurs = (cur: SecurityReview | null) => cur?.status === 'running' && cur.at === at && cur.agentId === undefined
  const w = await wordsIn($)
  const looked = isAudit ? [] : await Promise.all((await reposOf($)).map(async repo => ((await gitOut($, repo, ['rev-parse', '--git-dir'])) === null ? [] : [{ path: repo, base: bases[repo] ?? HEAD }])))
  const repos = looked.flat()
  const prompt = isAudit ? w.audit(root) : w.prompt(root, repos, shown.slice(0, FILES_LIMIT), Math.max(0, shown.length - FILES_LIMIT), hints, told)
  const spawned = await $.agent.spawn({ prompt, description: w.task, subagentType: 'Explore', model: settings.model }).catch(() => undefined)
  const agentId = spawned?.agentId ?? (spawned && !spawned.deny ? (await $.agent.list().catch(() => [])).findLast(a => a.spawnedBy === 'agent-lens' && a.description === w.task)?.id : undefined)
  if (!agentId) {
    await update($, reviewAtom, cur => (isOurs(cur) ? was : cur))
    // Not lost: the next turn's end reads them, from what is then HEAD.
    if (!isAudit) for (const path of files) edited.add(canonical(path))
    await $.ui.toast(isAudit ? w.auditFailedSpawn : w.failedSpawn)
    return { isStarted: false, isFailed: true }
  }
  if (!isAudit) hints = []
  agents.add(agentId)
  await update($, reviewAtom, cur => (isOurs(cur) ? { ...cur!, agentId } : cur))
  return { isStarted: true }
}

// A subagent's run ended: the watch's, its answer is read. In `auto`, what can be attacked now goes
// to Claude, as the plugin's message: no person said it. Past the rounds it waits on the row. A part
// turned off meanwhile shows the report and does nothing more.
export async function endSecurityAgent($: EngineInterface, agentId: string, answer: string) {
  const review = await read($, reviewAtom)
  // An agent may end before the spawn has written its id down.
  if (review?.status !== 'running' || (review.agentId !== agentId && !(review.agentId === undefined && agents.has(agentId)))) return
  const report = parseSecurityReport(answer)
  const w = await wordsIn($)
  const found = report?.findings ?? []
  // From what is there now: an edit let through meanwhile added its finding.
  await update($, reviewAtom, (cur): SecurityReview => ({ ...(cur ?? review), status: report ? 'done' : 'failed', findings: [...found, ...unsent(cur).filter(k => !found.some(f => isSame(f, k)))], checked: report?.checked ?? '' }))
  await logTried($, found.map(f => logOf(f, review.isAudit ? 'audit' : 'agent', 'found'))).catch(() => {})
  if (!report) await $.ui.toast(review.isAudit ? w.auditFailed : w.failed)
  else if (found.length > 0) await $.ui.toast(w.band(found.length))
  if (!isOn('security')) {
    queued = []
    queuedBases = {}
    return
  }
  const high = found.filter(f => f.severity === 'high')
  // An audit is of the whole project, and may be long: what to fix of it is the person's to say.
  if ((await modeIn($)) === 'auto' && !review.isAudit && high.length > 0 && rounds < ROUNDS && (await sendFindings($, high, false)) === 'sent') rounds++
  const next = queued
  const bases = queuedBases
  queued = []
  queuedBases = {}
  if (next.length > 0) await readFiles($, next, bases)
}

// To Claude: on the person's word as their own, by itself as the plugin's. Those not sent yet are
// read again here, so a second press sends nothing; what the engine dropped or failed stays unsent.
async function sendFindings($: EngineInterface, findings: readonly SecurityFinding[], isPersonsWord: boolean): Promise<'sent' | 'dropped' | 'none'> {
  const review = await read($, reviewAtom)
  const open = unsent(review).filter(f => findings.some(s => isSame(s, f)))
  if (open.length === 0) return 'none'
  const mark = (isSent: boolean) => (cur: SecurityReview | null) => cur && { ...cur, findings: cur.findings.map(f => (open.some(s => isSame(s, f)) ? { ...f, isSent } : f)) }
  await update($, reviewAtom, mark(true))
  const text = (await wordsIn($)).sendText(open, review?.isAudit)
  const r = await $.prompt.submit(isPersonsWord ? { text, asUser: true } : { text }).catch(() => ({ drop: 'failed' }))
  if (r.drop !== undefined) {
    await update($, reviewAtom, mark(false))
    return 'dropped'
  }
  if (isPersonsWord) personSpoke()
  told = [...told, ...open.map(f => `${f.file}${f.line ? `:${f.line}` : ''} ${f.kind}: ${f.problem}`)].slice(-TOLD_LIMIT)
  return 'sent'
}

// The watch's report the engine hands back as it ends is the pane's, not Claude's to read.
export async function securityReport($: EngineInterface, text: string) {
  const kept = (await read($, reviewAtom))?.agentId
  return [...agents, ...(kept ? [kept] : [])].some(id => text.includes(id)) ? (await wordsIn($)).task : undefined
}

async function allowRefused($: EngineInterface) {
  const w = await wordsIn($)
  const refused = await read($, refusedAtom)
  for (const r of refused) allowed.add(r.key)
  await update($, refusedAtom, () => [])
  return refused.length > 0 ? w.allowed(refused.length) : w.noneRefused
}

// The findings not sent and the secrets refused put aside: no secret is let through by it.
async function putAside($: EngineInterface) {
  await update($, reviewAtom, cur => {
    if (!cur) return cur
    const findings = cur.findings.filter(f => f.isSent)
    // None left of some is not a clean read, and is not to be shown as one.
    return findings.length === 0 && cur.findings.length > 0 && cur.status !== 'running' ? null : { ...cur, findings }
  })
  await update($, refusedAtom, () => [])
  return (await wordsIn($)).putAside
}

async function setAgentMode($: EngineInterface, mode: Mode) {
  const w = await wordsIn($)
  const isSaved = await $.store.set(MODE_KEY, mode).then(() => true, () => false)
  if (!isSaved) return w.modeNotSaved
  await update($, modeAtom, () => mode)
  // Left to a press: what auto had gathered for a next run is not read by itself later.
  if (mode === 'button') {
    snapshot = null
    queued = []
    queuedBases = {}
  }
  return w.modeSet[mode]
}

async function runAudit($: EngineInterface) {
  const w = await wordsIn($)
  const ran = await readFiles($, [], {}, true)
  return ran.isStarted ? w.auditStarted : ran.isFailed ? w.auditFailedSpawn : w.auditBusy
}

async function clearLog($: EngineInterface) {
  const clearing = logQueue.then(async () => {
    await update($, logAtom, () => [])
    await $.store.set(logKey(await $.session.root()), [])
  })
  logQueue = clearing.catch(() => {})
  await logQueue
  return (await wordsIn($)).logCleared
}

async function runNow($: EngineInterface) {
  const w = await wordsIn($)
  const lists = await Promise.all((await reposOf($)).map(repo => uncommittedIn($, repo).catch(() => null)))
  if (lists.every(list => list === null)) return w.noRepo
  const code = codeIn(lists.flatMap(list => list ?? []), await $.session.root())
  if (code.length === 0) return w.nothing
  const ran = await readFiles($, code)
  return ran.isStarted ? w.started(code.length) : ran.isFailed ? w.failedSpawn : w.running
}

export async function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: (await wordsIn($)).title, focus: true, closeOnEscape: true })
}

// `/security`: the pane; `run`: all that is uncommitted read now; `allow`: the secrets refused let
// through, on a person's word alone.
export async function securityCommand($: EngineInterface, args: string, origin: Origin | undefined) {
  const verb = args.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  const w = await wordsIn($)
  if (verb === 'allow') return { text: isPersons(origin) ? await allowRefused($) : w.onlyPerson }
  // The journal is the person's one trace of what the agent tried: an agent does not wipe it.
  if (verb === 'clear') return { text: isPersons(origin) ? await clearLog($) : w.onlyPersonClear }
  if (verb === 'audit') {
    const text = await runAudit($)
    await openPane($)
    return { text }
  }
  if (verb === 'run') {
    const text = await runNow($)
    await openPane($)
    return { text }
  }
  if (verb === 'agent') {
    const mode = modeOf(args.trim().split(/\s+/)[1]?.toLowerCase())
    if (!mode) return { text: w.modeSet[await modeIn($)] }
    // Stopping the watch is the person's to say, as letting a secret through is.
    return { text: isPersons(origin) ? await setAgentMode($, mode) : w.onlyPersonMode }
  }
  if (verb !== '') return { text: w.usage }
  const { isPlaced } = await openPane($)
  if (isPlaced) return { text: w.opened }
  // No pane to open: the journal is said here.
  const log = await read($, logAtom)
  if (log.length === 0) return { text: w.logEmpty }
  const lines = log.slice(0, LOG_SHOWN).map(entry => `${logHead(w, entry)}\n  ${entry.problem}${entry.evidence ? `\n  ${entry.evidence}` : ''}${entry.fix ? `\n  → ${entry.fix}` : ''}\n  ${w.by[entry.by]}`)
  return { text: `${w.logTitle(log.length)}\n${lines.join('\n')}${log.length > LOG_SHOWN ? `\n${w.logMore(log.length - LOG_SHOWN)}` : ''}` }
}

// The row above the prompt: the findings not sent yet, and the secrets held back.
export async function securityLine($: EngineInterface) {
  const open = unsent(await read($, reviewAtom)).length
  const refused = (await read($, refusedAtom)).length
  return open + refused > 0 ? (await wordsIn($)).line(open, refused) : null
}

export async function pane($: Parameters<PaneHook>[0], e: Parameters<PaneHook>[1]) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const w = await wordsIn($)
  const review = await read($, reviewAtom)
  const refused = await read($, refusedAtom)
  const act = (fn: () => Promise<unknown>) => () => void fn().catch(() => {})
  const say = (fn: () => Promise<string>) => act(async () => $.ui.toast(await fn()))
  const open = unsent(review)
  const n = review?.findings.length ?? 0
  const log = await read($, logAtom)
  // A run past its time is gone, and the way to start another stays open.
  const isBusy = isRunning(review, await $.clock.now())
  const mode = await modeIn($)
  return (
    <Box flexDirection="column" gap={1}>
      {refused.length > 0 ? (
        <Box flexDirection="column">
          <Text bold color="error">{w.refusedTitle(refused.length)}</Text>
          {refused.map((r, i) => (
            <Text key={`refused-${i}`} wrap="wrap">{`• ${r.kind} ${r.masked} — ${r.where === SHELL ? w.inShell : r.where}`}</Text>
          ))}
          <Text dimColor wrap="wrap">{w.refusedHelp}</Text>
        </Box>
      ) : null}
      {!review ? (
        <Text dimColor wrap="wrap">{mode === 'auto' ? w.empty : w.emptyButton}</Text>
      ) : isBusy ? (
        <Text color="warning" wrap="wrap">{review.isAudit ? w.auditing : w.reading(review.files.length)}</Text>
      ) : review.status === 'running' ? (
        <Text color="error" wrap="wrap">{`✗ ${w.gone}`}</Text>
      ) : review.status === 'failed' ? (
        <Text color="error" wrap="wrap">{`✗ ${review.isAudit ? w.auditFailed : w.failed}`}</Text>
      ) : n === 0 ? (
        <Text color="success" wrap="wrap">{review.isAudit ? w.auditClean(review.checked) : w.clean(review.files.length, review.checked)}</Text>
      ) : (
        <Text bold wrap="wrap">{review.isAudit ? w.auditSummary(n) : w.summary(n, review.files.length)}</Text>
      )}
      {review?.findings.map((f, i) => (
        <Box key={`finding-${i}`} flexDirection="column">
          <Text color={f.severity === 'high' ? 'error' : 'warning'} wrap="wrap">{`${w.severity[f.severity]} · ${f.kind} · ${f.file}${f.line ? `:${f.line}` : ''}${f.isSent ? ` · → ${w.sent}` : ''}`}</Text>
          <Text wrap="wrap">{`  ${f.problem}`}</Text>
          {f.fix ? <Text dimColor wrap="wrap">{`  → ${f.fix}`}</Text> : null}
        </Box>
      ))}
      <Box flexDirection="column">
        <Text bold>{w.logTitle(log.length)}</Text>
        {log.length === 0 ? <Text dimColor wrap="wrap">{w.logEmpty}</Text> : null}
        {log.slice(0, LOG_SHOWN).map((entry, i) => (
          <Box key={`log-${i}`} flexDirection="column">
            <Text color={entry.outcome === 'refused' ? 'success' : entry.outcome === 'noted' ? undefined : 'warning'} wrap="wrap">{logHead(w, entry)}</Text>
            <Text wrap="wrap">{`  ${entry.problem}`}</Text>
            {entry.evidence ? <Text dimColor wrap="wrap">{`  ${entry.evidence}`}</Text> : null}
            {entry.fix ? <Text dimColor wrap="wrap">{`  → ${entry.fix}`}</Text> : null}
            <Text dimColor wrap="wrap">{`  ${w.by[entry.by]}`}</Text>
          </Box>
        ))}
        {log.length > LOG_SHOWN ? <Text dimColor>{w.logMore(log.length - LOG_SHOWN)}</Text> : null}
      </Box>
      <Box flexDirection="row" gap={2}>
        {open.length > 0 ? (
          <Button key="security-send" label={w.send(open.length)} hotkey="j" variant="primary" onPress={act(async () => {
            if ((await sendFindings($, open, true)) === 'dropped') await $.ui.toast(w.sendDropped)
          })}>
            <Text dimColor>j</Text>
            {` ${w.send(open.length)}`}
          </Button>
        ) : null}
        {!isBusy ? (
          <Button key="security-audit" label={w.auditButton} hotkey="t" dimColor onPress={say(() => runAudit($))}>
            <Text dimColor>t</Text>
            {` ${w.auditButton}`}
          </Button>
        ) : null}
        {!isBusy ? (
          <Button key="security-run" label={review ? w.again : w.readNow} hotkey="r" dimColor onPress={say(() => runNow($))}>
            <Text dimColor>r</Text>
            {` ${review ? w.again : w.readNow}`}
          </Button>
        ) : null}
        <Button key="security-mode" label={w.modeButton[mode]} hotkey="m" dimColor onPress={say(() => setAgentMode($, mode === 'auto' ? 'button' : 'auto'))}>
          <Text dimColor>m</Text>
          {` ${w.modeButton[mode]}`}
        </Button>
        {open.length + refused.length > 0 ? (
          <Button key="security-aside" label={w.aside} hotkey="x" dimColor onPress={say(() => putAside($))}>
            <Text dimColor>x</Text>
            {` ${w.aside}`}
          </Button>
        ) : null}
        {refused.length > 0 ? (
          <Button key="security-allow" label={w.allow} hotkey="a" dimColor onPress={say(() => allowRefused($))}>
            <Text dimColor>a</Text>
            {` ${w.allow}`}
          </Button>
        ) : null}
      </Box>
    </Box>
  )
}
