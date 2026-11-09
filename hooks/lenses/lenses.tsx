import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'

import type { LensFinding, LensReview } from '../../types'
import type { PaneHook } from '../core/hooks'
import { langIn } from '../core/lang'
import { ownerNow, send } from '../core/outbox'
import { gitAliases, nestedRepos } from '../core/repos'
import { userFilePath } from '../core/user'
import { acceptanceOf, flush, isAutoNow, type Point, sendPoints, settledPoints } from '../ledger/ledger'
import { ownAgent, spendOn } from '../core/spend'
import { isOn } from '../parts/parts'
import { below, joinPath } from '../review/diff'
import { sessionRequests } from '../review/review'
import { modelOf, REVIEW_MODEL } from '../review/rules'
import { specInView } from '../spec/lens'
import { parseLensReport, pushedRefs, sendsOut } from './report'
import { type Catalog, type LensContext, type RepoChanges, WORDS } from './words'

// The review of the branch by lenses: the kinds of mistake reviews catch, each looked for across the
// whole change by an agent that made none of it, its findings shown and sent to Claude on the
// person's word. The lenses are the mod's own, so it works for anyone; the project's LENSES.md adds
// its own, and the person's ~/.claude/review-lenses.md where they turn it on. It reads the branch,
// not a turn: a look this wide is worth its cost before a commit or a merge request, not at every turn.

const reviewAtom = atom({ plugin: 'agent-lens', key: 'lenses.review' } as const, null)
const offerAtom = atom({ plugin: 'agent-lens', key: 'lenses.offer' } as const, null)
// The changes offered the review once, by project: one ticked again after a task reopened is not
// offered again.
const offeredKey = (root: string) => `lenses:offered:${root}`
// The commits of the project's repositories when the lenses last read them, and whether a push held
// for that read may go once whatever came after it: in `auto` a push of other commits waits for
// them. Kept across sessions, as the work is.
const reviewedKey = (root: string) => `lenses:reviewed:${root}`
type Reviewed = { heads: string }
// The turn of the findings a held push waits on: the fixes it commits go out with the push, as
// commits after those read; past that turn, new commits are read first.
const PUSH_TAG = 'lenses-push'
export const PANE = 'agent-lens-lenses'
// The project's lenses, and the person's, beside the mod's own.
const LENSES = 'LENSES.md'
const USER_LENSES = 'review-lenses.md'
// A run past this is taken as gone: another may start.
const STALE_MS = 30 * 60_000
// How much of a catalog the agent is shown, and how many new files are named to it.
const CATALOG_LIMIT = 20_000
const FILES_LIMIT = 200
// The model that reads the branch through the lenses, the review's (`reviewModel`): a look this wide
// wants more than the haiku of each edit, as the docs agent does; it reads code, so a general agent,
// not one that skims.
const AGENT_TYPE = 'general-purpose'
// The second look at the findings not shown from the code: the small model, on the lines named.
const CHECK_MODEL = 'haiku'
const CHECK_LINES = 12
const CHECK_LIMIT = 40_000
// How much of the session the review is told of.
const CONTEXT_ITEMS = 30
// Where the branch most likely forks from, where the remote names no default.
const BASES = ['main', 'master', 'develop', 'trunk']

// off: the lenses only on /changes lenses; offer: the row offers them once a change's tasks are
// ticked; auto: they run by themselves then, and before the agent pushes the work.
type Mode = 'off' | 'offer' | 'auto'
let settings: { includeUserLenses: boolean; mode: Mode; model: string } = { includeUserLenses: false, mode: 'offer', model: REVIEW_MODEL }
// The review a push waits for, by its agent, or the one starting, whose agent is not known yet: its
// outcome goes to Claude as the next prompt, and the push with it. Another review's end is no answer
// to that push.
const STARTING = '\0starting'
let pushFor: string | null = null
// The agents this part started, by id, as long as it runs: their report is the pane's.
const agents = new Set<string>()

export function configureLenses(options: PluginOptions) {
  const mode = options.lenses === 'off' || options.lenses === 'auto' ? options.lenses : 'offer'
  settings = { includeUserLenses: options.includeUserLenses === true, mode, model: modelOf(options.reviewModel, REVIEW_MODEL) }
}

async function wordsIn($: EngineInterface) {
  return WORDS[await langIn($)]
}

async function gitOut($: EngineInterface, root: string, args: string[]) {
  const r = await $.process.run(['git', '-c', 'core.quotePath=false', '-C', root, ...args], { cwd: root, timeoutMs: 15_000 }).catch(() => null)
  return r?.exitCode === 0 ? r.stdout.trim() : null
}

// The commit the branch forks from: from the base given, else from the remote's default branch, else
// from the first of the usual names there is. A merge base always: a branch given by its name is read
// from where this one left it, not from its tip, whose newer commits would read as taken out; a
// commit of this branch given is its own merge base, so only what changed since it is read.
async function baseOf($: EngineInterface, root: string, given: string) {
  const remote = given === '' ? ((await gitOut($, root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])) ?? undefined) : undefined
  for (const name of given !== '' ? [given] : [...(remote ? [remote] : []), ...BASES]) {
    const fork = await gitOut($, root, ['merge-base', 'HEAD', name])
    if (fork) return fork.slice(0, 12)
  }
  return null
}

// One repository looked at: its folder, whether the base given is one of its, and, where it has a
// base, what changed there since, how the person reads the base, and how many files.
type Looked = { folder: string; isAsked: boolean } & ({ read?: undefined } | { read: RepoChanges; label: string; count: number })

// A base as the person reads it: by the folder of its repository where it is not the project's own.
const labelOf = (base: string, folder: string) => (folder === '.' ? base : `${base} (${folder})`)

const lines = (out: string | null) => (out ?? '').split('\n').map(s => s.trim()).filter(Boolean)
const countOf = (review: Pick<LensReview, 'results' | 'outside'>) => review.results.reduce((n, r) => n + r.findings.filter(f => !f.dropped).length, 0) + review.outside.length
const placeText = (p: { file: string; line?: number }) => `${p.file}${p.line ? `:${p.line}` : ''}`

// What the review reads beside the mod's own lenses: the project's file, and the person's where
// they turned it on.
async function catalogsOf($: EngineInterface, root: string) {
  const readAt = async (path: string | undefined) => (path ? await $.fs.read(path).catch(() => undefined) : undefined)
  const clipped = (text: string) => (text.length > CATALOG_LIMIT ? `${text.slice(0, CATALOG_LIMIT)}\n[...]` : text)
  const found: Catalog[] = []
  const project = await readAt(joinPath(root, LENSES))
  if (project?.trim()) found.push({ name: LENSES, text: clipped(project) })
  if (settings.includeUserLenses) {
    const user = await readAt(await userFilePath($, USER_LENSES))
    if (user?.trim()) found.push({ name: `~/.claude/${USER_LENSES}`, text: clipped(user) })
  }
  return found
}

// `/changes lenses [base]`: the branch read through each lens, against where it forks from the base
// given or the default one, one review at a time.
export async function lensesCommand($: EngineInterface, args: string) {
  const [verb = '', given = ''] = args.trim().split(/\s+/)
  if (verb.toLowerCase() !== 'lenses') return undefined
  const w = await wordsIn($)
  const root = await $.session.root()
  const at = await $.clock.now()
  // Taken first, in the one write that also looks, before git is asked anything: a second press
  // while this one looks finds it running. Given back as it was where this one stops short, unless
  // another took its place since.
  const running: LensReview = { status: 'running', at, base: '', asked: given, results: [], outside: [], untouched: [] }
  let was: LensReview | null = null
  let isTaken = false
  await update($, reviewAtom, cur => {
    if (cur?.status === 'running' && at - cur.at < STALE_MS) return cur
    was = cur
    isTaken = true
    return running
  })
  if (!isTaken) {
    await openPane($)
    return { text: w.running }
  }
  const isOurs = (cur: LensReview | null) => cur?.status === 'running' && cur.at === at && cur.agentId === undefined
  // A push waiting on this start is answered: nothing holds it now.
  const stop = async (text: string) => {
    await update($, reviewAtom, cur => (isOurs(cur) ? was : cur))
    if (pushFor === STARTING) {
      pushFor = null
      await send($, { from: 'lenses' }, w.pushFree)
    }
    return { text }
  }
  // A base read as an option of git is none.
  if (given.startsWith('-')) return stop(w.noBase(given))
  // The project's own repository, and each of its own in a top folder, as dev-env keeps its clones:
  // a branch of the work lives in them as much as in the project's.
  const isRepo = (await gitOut($, root, ['rev-parse', '--show-toplevel'])) !== null
  const repos = [...(isRepo ? [root] : []), ...(await nestedRepos($, root))]
  if (repos.length === 0) return stop(w.noRepo)
  // A base given is read where it is; elsewhere each repository from where it forks by default. One
  // with neither is said so, not left out unsaid.
  const looked = await Promise.all(
    repos.map(async (repo): Promise<Looked> => {
      const folder = below(repo, root) ?? '.'
      const asked = given !== '' ? await baseOf($, repo, given) : null
      const base = asked ?? (await baseOf($, repo, ''))
      if (!base) return { folder, isAsked: false }
      const changed = lines(await gitOut($, repo, ['diff', '--name-only', base]))
      // A clone in a folder of this repository is listed as a folder git does not know of: no file.
      const untracked = lines(await gitOut($, repo, ['ls-files', '--others', '--exclude-standard'])).filter(f => !f.endsWith('/'))
      const named = [...untracked.slice(0, FILES_LIMIT), ...(untracked.length > FILES_LIMIT ? [w.more(untracked.length - FILES_LIMIT)] : [])]
      return { folder, isAsked: asked !== null, read: { path: repo, base, changed: changed.length, untracked: named }, label: labelOf(base, folder), count: changed.length + untracked.length }
    }),
  )
  if (given !== '' && !looked.some(l => l.isAsked)) return stop(w.noBase(given))
  const based = looked.flatMap(l => (l.read !== undefined ? [l] : []))
  if (based.length === 0) return stop(w.noBase(''))
  const found = based.filter(l => l.count > 0)
  if (found.length === 0) return stop(w.nothing(based.map(l => l.label).join(', ')))
  const base = found.map(l => l.label).join(', ')
  const unread = looked.filter(l => l.read === undefined).map(l => (l.folder === '.' ? w.ownRepo : l.folder))
  const prompt = w.prompt(root, found.map(l => l.read), await catalogsOf($, root), await contextOf($, found.map(l => l.read)))
  const spawned = await $.agent.spawn({ prompt, description: w.task, subagentType: AGENT_TYPE, model: settings.model }).catch(() => undefined)
  const agentId =
    spawned?.agentId ?? (spawned && !spawned.deny ? (await $.agent.list().catch(() => [])).findLast(a => a.spawnedBy === 'agent-lens' && a.description === w.task)?.id : undefined)
  if (!agentId) return stop(w.failedSpawn)
  agents.add(agentId)
  ownAgent(agentId, 'lenses')
  const heads = await headsOf($, root)
  await update($, reviewAtom, cur => (isOurs(cur) ? { ...running, base, agentId, heads } : cur))
  if (pushFor === STARTING) pushFor = agentId
  await update($, offerAtom, () => null)
  await openPane($)
  return { text: `${w.started(found.reduce((n, l) => n + l.count, 0), base)}${unread.length > 0 ? ` ${w.unread(unread)}` : ''}` }
}

// What the review is told beside the diff: what was asked in the session, the change being built,
// the commits' messages, and what was settled before.
async function contextOf($: EngineInterface, repos: readonly RepoChanges[]): Promise<LensContext> {
  const last = (items: readonly string[]) => items.slice(-CONTEXT_ITEMS)
  const spec = await specInView($).catch(() => undefined)
  const commits = (await Promise.all(repos.map(r => gitOut($, r.path, ['log', '--format=%s', `${r.base}..HEAD`])))).flatMap(lines)
  return {
    requests: last(await sessionRequests($).catch(() => [])),
    ...(spec ? { spec: { change: spec.change, tasks: spec.tasks.slice(0, CONTEXT_ITEMS), requirements: spec.requirements.map(r => r.name).slice(0, CONTEXT_ITEMS) } } : {}),
    commits: commits.slice(0, CONTEXT_ITEMS),
    settled: last(await settledPoints($).catch(() => [])),
  }
}

// The findings the agent did not show from the code get a second look by the small model, on the
// lines they name: one that does not hold is kept aside with why, not shown as a finding.
async function secondLook($: EngineInterface, root: string, results: LensReview['results']) {
  const doubtful = results.flatMap((r, i) => r.findings.map((f, j) => ({ f, i, j }))).filter(({ f }) => f.confidence !== 'confirmed' || !f.evidence)
  if (doubtful.length === 0) return results
  const w = await wordsIn($)
  let budget = CHECK_LIMIT
  const excerpt = async (p: { file: string; line?: number }) => {
    const text = await $.fs.read(joinPath(root, p.file)).catch(() => undefined)
    if (text === undefined) return `=== ${placeText(p)} ===\n${w.checkNoFile}`
    const all = text.split('\n')
    const from = Math.max(0, (p.line ?? 1) - 1 - CHECK_LINES)
    const shown = all.slice(from, from + CHECK_LINES * 2 + 1).map((l, k) => `${from + k + 1}  ${l}`).join('\n')
    const cut = shown.slice(0, Math.max(0, budget))
    budget -= cut.length
    return `=== ${placeText(p)} ===\n${cut}`
  }
  const items = await Promise.all(
    doubtful.map(async ({ f }, k) => `[${k + 1}] ${f.problem}${f.risk ? ` (${f.risk})` : ''}${f.evidence ? `\n${w.checkEvidence}: ${f.evidence}` : ''}\n${(await Promise.all([f, ...(f.places ?? [])].slice(0, 3).map(excerpt))).join('\n')}`),
  )
  const r = await $.model.complete({ model: CHECK_MODEL, system: w.checkSystem, prompt: items.join('\n\n'), maxTokens: 800 }).catch(() => undefined)
  spendOn('lenses', r?.usage)
  if (!r?.isAnswered) return results
  const verdicts = parseHolds(r.text)
  if (!verdicts) return results
  return results.map((res, i) => ({
    ...res,
    findings: res.findings.map((f, j): LensFinding => {
      const k = doubtful.findIndex(d => d.i === i && d.j === j)
      const why = k >= 0 ? verdicts.get(k + 1) : undefined
      return why !== undefined ? { ...f, dropped: why || w.checkDropped } : f
    }),
  }))
}

// The small model's answer: the findings that do not hold, by number, each with why.
function parseHolds(text: string) {
  const at = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (at < 0 || end < at) return undefined
  try {
    const raw = JSON.parse(text.slice(at, end + 1)) as { dropped?: unknown }
    if (!Array.isArray(raw.dropped)) return undefined
    const out = new Map<number, string>()
    for (const d of raw.dropped) {
      if (typeof d === 'number') out.set(d, '')
      else if (typeof d === 'object' && d !== null && typeof (d as { n?: unknown }).n === 'number') out.set((d as { n: number }).n, String((d as { why?: unknown }).why ?? '').trim())
    }
    return out
  } catch {
    return undefined
  }
}

// A subagent's run ended: the review's, its answer is read, its doubtful findings looked at again.
export async function endLensAgent($: EngineInterface, agentId: string, answer: string) {
  const review = await read($, reviewAtom)
  if (review?.status !== 'running' || review.agentId !== agentId) return
  const root = await $.session.root()
  const parsed = parseLensReport(answer)
  const report = parsed ? { ...parsed, results: await secondLook($, root, parsed.results).catch(() => parsed.results) } : undefined
  // Stopped or started again during the second look: this answer is no one's now.
  const now = await read($, reviewAtom)
  if (now?.status !== 'running' || now.agentId !== agentId) return
  const isForPush = pushFor === agentId
  await update($, reviewAtom, (cur): LensReview => (cur?.agentId === agentId ? { ...review, status: report ? 'done' : 'failed', results: report?.results ?? [], outside: report?.outside ?? [], untouched: report?.untouched ?? [] } : cur!))
  const n = report ? countOf(report) : 0
  const w = await wordsIn($)
  // Read, whatever the agent makes of it: the commits it started on. A push held for it goes with
  // the fixes of the turn its findings start, so a review never follows its own findings round after
  // round. A review that gave no list holds no push of the commits it was started on.
  if (report || isForPush) await $.store.set(reviewedKey(root), { heads: review.heads ?? (await headsOf($, root)) } satisfies Reviewed)
  if (isForPush) {
    if (n > 0) await sendFindings($, { tag: PUSH_TAG, after: w.pushAfter })
    pushFor = null
    if (n === 0) await send($, { from: 'lenses' }, report ? w.pushClean : w.pushFailed)
    return
  }
  if (n === 0) return
  if (!isAutoNow()) await $.ui.toast(w.band(n))
  else await flush($).catch(() => {})
}

// The findings open on the pane: not dropped by the second look, not taken to Claude yet. By an id of
// the review and their place in it.
function openOf(review: LensReview) {
  const taken = new Set(review.taken ?? [])
  const found = review.results.flatMap((r, i) => r.findings.flatMap((f, j) => (f.dropped ? [] : [{ id: `${review.at}:${i}:${j}`, lens: r.lens, f }])))
  return {
    findings: found.filter(x => !taken.has(x.id)),
    outside: review.outside.map((o, k) => ({ id: `${review.at}:o:${k}`, o })).filter(x => !taken.has(x.id)),
  }
}

// What the ledger takes to Claude: the findings open, the review done and no push waiting on it.
export async function lensPoints($: EngineInterface): Promise<Point[]> {
  const review = await read($, reviewAtom)
  if (review?.status !== 'done' || (pushFor !== null && pushFor === review.agentId)) return []
  return lensPointsOf($, review)
}

async function lensPointsOf($: EngineInterface, review: LensReview): Promise<Point[]> {
  const w = await wordsIn($)
  const open = openOf(review)
  return [
    ...open.findings.map(({ id, lens, f }) => ({
      id,
      where: placeText(f),
      text: `${lens}: ${f.problem}${f.risk ? ` (${f.risk})` : ''}${f.places?.length ? ` ${w.alsoAt(f.places.map(placeText))}` : ''}`,
      isMinor: false,
      ...(f.confidence ? { confidence: f.confidence } : {}),
    })),
    ...open.outside.map(({ id, o }) => ({ id, where: w.outsideWhere, text: o, isMinor: false })),
  ]
}

// Taken to Claude, or put aside by the person: off the pane's count.
export async function lensTaken($: EngineInterface, ids: readonly string[]) {
  await update($, reviewAtom, review => {
    if (!review) return review
    const taken = [...new Set([...(review.taken ?? []), ...ids])]
    const next = { ...review, taken }
    const open = openOf(next)
    return open.findings.length === 0 && open.outside.length === 0 ? { ...next, isSent: true as const } : next
  })
}

// The commit of each repository in `heads`, by its folder.
const headsIn = (heads: string) => new Map(heads.split('\n').map(l => [l.slice(0, l.lastIndexOf('@')), l.slice(l.lastIndexOf('@') + 1)] as const))

// The commits of the project's own repository and of each in a top folder, as one string.
async function headsOf($: EngineInterface, root: string) {
  const repos = [root, ...(await nestedRepos($, root))]
  return (await Promise.all(repos.map(async repo => `${repo}@${(await gitOut($, repo, ['rev-parse', 'HEAD'])) ?? ''}`))).join('\n')
}

// In `auto`, a push of commits the lenses have not read is refused once, the review started, its
// outcome sent as the next prompt: the main loop's, a subagent's (its outcome lands on the main loop,
// which is told), or a tool of an MCP server's (`command` null). The same commits push again freely,
// a pull request opened after its push among them, and so do the fixes made in the turn of the
// findings a held push waited on. A push of another branch goes where its commit is among those read,
// and is told to check it out otherwise, as the lenses read the one checked out. Where the review cannot run (no repository, no fork point,
// nothing changed), the push goes; a review gone past its time holds nothing.
export async function lensesBeforePush($: EngineInterface, command: string | null, agentId: string | undefined) {
  if (settings.mode !== 'auto') return undefined
  const root = await $.session.root()
  // The aliases are read only where git is named: not on every command, and once a session.
  const aliases = command === null || !/\bgit\b/.test(command) ? {} : await gitAliases($, root)
  if (command !== null && !sendsOut(command, aliases)) return undefined
  const w = await wordsIn($)
  const head = await gitOut($, root, ['rev-parse', 'HEAD'])
  const reviewed = (await $.store.get(reviewedKey(root)).catch(() => undefined)) as Reviewed | undefined
  const readHead = reviewed ? headsIn(reviewed.heads).get(root) : undefined
  const refs = command === null ? [] : pushedRefs(command, aliases)
  let isOwnPushed = refs.length === 0
  for (const ref of refs) {
    const sha = await gitOut($, root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    if (sha === null || head === null || sha === head) isOwnPushed = true
    // Another branch goes as read where its commit is among those the lenses read.
    else if (!readHead || (sha !== readHead && (await gitOut($, root, ['merge-base', '--is-ancestor', sha, readHead])) === null)) return w.pushOther(ref)
  }
  if (!isOwnPushed) return undefined
  const heads = await headsOf($, root)
  if (reviewed && (reviewed.heads === heads || (await isFixOf($, reviewed.heads, heads)))) {
    // The fixes are read as part of what went: their push spends the pass.
    if (reviewed.heads !== heads) await $.store.set(reviewedKey(root), { heads } satisfies Reviewed)
    return undefined
  }
  const at = await $.clock.now()
  const was = await read($, reviewAtom)
  // One running, its agent known or still starting, is waited for: no second review.
  if (was?.status === 'running' && at - was.at < STALE_MS) {
    pushFor = was.agentId ?? STARTING
    return agentId === undefined ? w.pushRunning : w.pushHeldSub
  }
  await lensesCommand($, 'lenses')
  const review = await read($, reviewAtom)
  if (review?.status !== 'running' || review.agentId === undefined) return undefined
  pushFor = review.agentId
  return agentId === undefined ? w.pushHeld : w.pushHeldSub
}

// In the turn of the findings a held push waited on, the commits since those read are its fixes:
// each repository's commit read is under its commit now.
async function isFixOf($: EngineInterface, was: string, now: string) {
  const by = ownerNow()
  if (by?.from !== 'ledger' || by.tag !== PUSH_TAG) return false
  const before = headsIn(was)
  for (const [repo, sha] of headsIn(now)) {
    const old = before.get(repo)
    if (old === undefined || old === '' || sha === '') return false
    if (old !== sha && (await gitOut($, repo, ['merge-base', '--is-ancestor', old, sha])) === null) return false
  }
  return true
}

// The review's report the engine hands back as it ends is the pane's, not Claude's to read.
export async function lensReport($: EngineInterface, text: string) {
  const kept = (await read($, reviewAtom))?.agentId
  return [...agents, ...(kept ? [kept] : [])].some(id => text.includes(id)) ? (await wordsIn($)).task : undefined
}

// Whether the findings open went to Claude, through the ledger, numbered for Claude's answer.
async function sendFindings($: EngineInterface, opts: { tag?: string; after?: string } = {}) {
  const review = await read($, reviewAtom)
  if (!review || review.status !== 'done') return false
  const points = await lensPointsOf($, review)
  return sendPoints($, 'lenses', points, opts)
}

// An OpenSpec change with every task ticked: before its archive, the row offers the branch read
// through the lenses, once a change, the person's to run. OpenSpec hands the agent that builds a
// change no rules of the code, so this is the look at the whole of it before it is done.
export async function offerLenses($: EngineInterface, change: string) {
  if (settings.mode === 'off' || !isOn('lenses')) return
  const root = await $.session.root()
  const offered = ((await $.store.get(offeredKey(root)).catch(() => undefined)) ?? []) as string[]
  if (offered.includes(change)) return
  await $.store.set(offeredKey(root), [...offered, change].slice(-50))
  // In `auto` it runs by itself, its findings on the row as any review's.
  if (settings.mode === 'auto') return void (await runOffered($))
  await update($, offerAtom, () => ({ change }))
  await $.ui.toast((await wordsIn($)).offer(change))
}

export async function offerLine($: EngineInterface) {
  const offer = await read($, offerAtom)
  return offer ? (await wordsIn($)).offer(offer.change) : null
}

export async function runOffered($: EngineInterface) {
  const ran = await lensesCommand($, 'lenses')
  if (ran) await $.ui.toast(ran.text)
}

export async function dismissOffer($: EngineInterface) {
  await update($, offerAtom, () => null)
}

export async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: (await wordsIn($)).title, focus: true, closeOnEscape: true })
}

// The row above the prompt: the findings not sent yet, while there are some.
export async function lensesLine($: EngineInterface) {
  const review = await read($, reviewAtom)
  if (review?.status !== 'done' || review.isSent) return null
  const open = openOf(review)
  const n = open.findings.length + open.outside.length
  return n > 0 ? (await wordsIn($)).band(n) : null
}

export async function pane($: Parameters<PaneHook>[0], e: Parameters<PaneHook>[1]) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const w = await wordsIn($)
  const review = await read($, reviewAtom)
  const act = (fn: () => Promise<unknown>) => () => void fn().catch(() => {})
  if (!review) return <Text dimColor>/changes lenses</Text>
  const n = countOf(review)
  const open = openOf(review)
  const toSend = open.findings.length + open.outside.length
  const lensCount = review.results.filter(r => r.findings.some(f => !f.dropped)).length
  // What the second look did not hold is not the person's to read: its count, so the look shows.
  const dropped = review.results.reduce((n, r) => n + r.findings.filter(f => f.dropped).length, 0)
  const { answered, held } = await acceptanceOf($, 'lenses')
  return (
    <Box flexDirection="column" gap={1}>
      {review.status === 'running' ? (
        <Text color="warning">{w.reading(review.base || '…')}</Text>
      ) : review.status === 'failed' ? (
        <Text color="error">{`✗ ${w.failed}`}</Text>
      ) : n === 0 ? (
        <Text color="success">{w.clean(review.results.length)}</Text>
      ) : (
        <Text bold>{w.summary(n, lensCount, review.base)}</Text>
      )}
      {review.results.map((r, i) => (
        <Box key={`lens-${i}`} flexDirection="column">
          <Text color={r.status === 'findings' ? 'warning' : r.status === 'clean' ? 'success' : undefined} wrap="wrap">{`${w.status[r.status]} ${r.lens}`}</Text>
          {r.status === 'findings' ? (
            r.findings.map((f, j) =>
              f.dropped ? null : (
                <Box key={`lens-${i}-${j}`} flexDirection="column" paddingLeft={2}>
                  <Text wrap="wrap">{`• ${placeText(f)} — ${f.problem}`}</Text>
                  {f.places?.length ? <Text dimColor wrap="wrap">{`  ${w.alsoAt(f.places.map(placeText))}`}</Text> : null}
                  {f.risk ? <Text dimColor wrap="wrap">{`  → ${f.risk}`}</Text> : null}
                </Box>
              ),
            )
          ) : r.checked ? (
            <Text dimColor wrap="wrap">{`  ${r.checked}`}</Text>
          ) : null}
        </Box>
      ))}
      {review.outside.length > 0 ? (
        <Box flexDirection="column">
          <Text bold>{w.outside}</Text>
          {review.outside.map((o, i) => (
            <Text key={`outside-${i}`} wrap="wrap">{`• ${o}`}</Text>
          ))}
        </Box>
      ) : null}
      {dropped > 0 ? <Text dimColor>{w.droppedTitle(dropped)}</Text> : null}
      {review.untouched.length > 0 ? (
        <Box flexDirection="column">
          <Text bold>{w.untouched}</Text>
          {review.untouched.map((o, i) => (
            <Text key={`untouched-${i}`} dimColor wrap="wrap">{`• ${o}`}</Text>
          ))}
        </Box>
      ) : null}
      <Box flexDirection="row" gap={1}>
        {review.status === 'done' && toSend > 0 && !review.isSent ? (
          <Button key="lenses-send" label={w.send(toSend)} hotkey="j" variant="primary" onPress={act(() => sendFindings($))}>
            <Text dimColor>j</Text>
            {` ${w.send(toSend)}`}
          </Button>
        ) : null}
        {review.isSent ? <Text dimColor>{`→ ${w.sent}`}</Text> : null}
        {review.status !== 'running' ? (
          <Button key="lenses-again" label={w.again} hotkey="r" dimColor onPress={act(async () => {
              const ran = await lensesCommand($, `lenses ${review.asked}`)
              if (ran) await $.ui.toast(ran.text)
            })}>
            <Text dimColor>r</Text>
            {` ${w.again}`}
          </Button>
        ) : null}
      </Box>
      {answered > 0 ? <Text dimColor>{w.acceptance(held, answered)}</Text> : null}
    </Box>
  )
}
