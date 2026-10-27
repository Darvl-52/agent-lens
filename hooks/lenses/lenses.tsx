import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'

import type { LensReview } from '../../types'
import type { PaneHook } from '../core/hooks'
import { langIn } from '../core/lang'
import { userFilePath } from '../core/user'
import { joinPath } from '../review/diff'
import { parseLensReport } from './report'
import { type Catalog, WORDS } from './words'

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
export const PANE = 'agent-lens-lenses'
// The project's lenses, and the person's, beside the mod's own.
const LENSES = 'LENSES.md'
const USER_LENSES = 'review-lenses.md'
// A run past this is taken as gone: another may start.
const STALE_MS = 30 * 60_000
// How much of a catalog the agent is shown, and how many new files are named to it.
const CATALOG_LIMIT = 20_000
const FILES_LIMIT = 200
// The model that reads the branch through the lenses: a look this wide wants more than the haiku of
// each edit, as the docs agent does.
const MODEL = 'sonnet'
// Where the branch most likely forks from, where the remote names no default.
const BASES = ['main', 'master', 'develop', 'trunk']

let settings = { includeUserLenses: false }
// The agents this part started, by id, as long as it runs: their report is the pane's.
const agents = new Set<string>()

export function configureLenses(options: PluginOptions) {
  settings = { includeUserLenses: options.includeUserLenses === true }
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

const lines = (out: string | null) => (out ?? '').split('\n').map(s => s.trim()).filter(Boolean)
const countOf = (review: Pick<LensReview, 'results' | 'outside'>) => review.results.reduce((n, r) => n + r.findings.length, 0) + review.outside.length

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
  const stop = async (text: string) => (await update($, reviewAtom, cur => (isOurs(cur) ? was : cur)), { text })
  // A base read as an option of git is none.
  if (given.startsWith('-')) return stop(w.noBase(given))
  if ((await gitOut($, root, ['rev-parse', '--show-toplevel'])) === null) return stop(w.noRepo)
  const base = await baseOf($, root, given)
  if (!base) return stop(w.noBase(given))
  const changed = lines(await gitOut($, root, ['diff', '--name-only', base]))
  const untracked = lines(await gitOut($, root, ['ls-files', '--others', '--exclude-standard']))
  if (changed.length + untracked.length === 0) return stop(w.nothing(base))
  const named = [...untracked.slice(0, FILES_LIMIT), ...(untracked.length > FILES_LIMIT ? [w.more(untracked.length - FILES_LIMIT)] : [])]
  const prompt = w.prompt(root, base, changed.length, named, await catalogsOf($, root))
  const spawned = await $.agent.spawn({ prompt, description: w.task, subagentType: 'Explore', model: MODEL }).catch(() => undefined)
  const agentId =
    spawned?.agentId ?? (spawned && !spawned.deny ? (await $.agent.list().catch(() => [])).findLast(a => a.spawnedBy === 'agent-lens' && a.description === w.task)?.id : undefined)
  if (!agentId) return stop(w.failedSpawn)
  agents.add(agentId)
  await update($, reviewAtom, cur => (isOurs(cur) ? { ...running, base, agentId } : cur))
  await update($, offerAtom, () => null)
  await openPane($)
  return { text: w.started(changed.length + untracked.length, base) }
}

// A subagent's run ended: the review's, its answer is read.
export async function endLensAgent($: EngineInterface, agentId: string, answer: string) {
  const review = await read($, reviewAtom)
  if (review?.status !== 'running' || review.agentId !== agentId) return
  const report = parseLensReport(answer)
  await update($, reviewAtom, (): LensReview => ({ ...review, status: report ? 'done' : 'failed', results: report?.results ?? [], outside: report?.outside ?? [], untouched: report?.untouched ?? [] }))
  const n = report ? countOf(report) : 0
  if (n > 0) await $.ui.toast((await wordsIn($)).band(n))
}

// The review's report the engine hands back as it ends is the pane's, not Claude's to read.
export async function lensReport($: EngineInterface, text: string) {
  const kept = (await read($, reviewAtom))?.agentId
  return [...agents, ...(kept ? [kept] : [])].some(id => text.includes(id)) ? (await wordsIn($)).task : undefined
}

async function sendFindings($: EngineInterface) {
  const review = await read($, reviewAtom)
  if (!review || review.status !== 'done' || review.isSent || countOf(review) === 0) return
  await update($, reviewAtom, () => ({ ...review, isSent: true as const }))
  const r = await $.prompt.submit({ text: (await wordsIn($)).sendText(review.results, review.outside), asUser: true })
  if (r.drop !== undefined) await update($, reviewAtom, () => review)
}

// An OpenSpec change with every task ticked: before its archive, the row offers the branch read
// through the lenses, once a change, the person's to run. OpenSpec hands the agent that builds a
// change no rules of the code, so this is the look at the whole of it before it is done.
export async function offerLenses($: EngineInterface, change: string) {
  const root = await $.session.root()
  const offered = ((await $.store.get(offeredKey(root)).catch(() => undefined)) ?? []) as string[]
  if (offered.includes(change)) return
  await $.store.set(offeredKey(root), [...offered, change].slice(-50))
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
  const n = countOf(review)
  return n > 0 ? (await wordsIn($)).band(n) : null
}

export async function pane($: Parameters<PaneHook>[0], e: Parameters<PaneHook>[1]) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const w = await wordsIn($)
  const review = await read($, reviewAtom)
  const act = (fn: () => Promise<unknown>) => () => void fn().catch(() => {})
  if (!review) return <Text dimColor>/changes lenses</Text>
  const n = countOf(review)
  const lensCount = review.results.filter(r => r.status === 'findings').length
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
            r.findings.map((f, j) => (
              <Box key={`lens-${i}-${j}`} flexDirection="column" paddingLeft={2}>
                <Text wrap="wrap">{`• ${f.file}${f.line ? `:${f.line}` : ''} — ${f.problem}`}</Text>
                {f.risk ? <Text dimColor wrap="wrap">{`  → ${f.risk}`}</Text> : null}
              </Box>
            ))
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
      {review.untouched.length > 0 ? (
        <Box flexDirection="column">
          <Text bold>{w.untouched}</Text>
          {review.untouched.map((o, i) => (
            <Text key={`untouched-${i}`} dimColor wrap="wrap">{`• ${o}`}</Text>
          ))}
        </Box>
      ) : null}
      <Box flexDirection="row" gap={1}>
        {review.status === 'done' && n > 0 && !review.isSent ? (
          <Button key="lenses-send" label={w.send(n)} hotkey="j" variant="primary" onPress={act(() => sendFindings($))}>
            <Text dimColor>j</Text>
            {` ${w.send(n)}`}
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
    </Box>
  )
}
