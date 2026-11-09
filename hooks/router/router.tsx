import type { EngineInterface, Hook, MatchedHook, PluginOptions } from 'claude-code'

import type { Decision, Pick, Stage } from '../../types/router'
import type { PaneHook } from '../core/hooks'
import { ownerNow } from '../core/outbox'
import { spendOn } from '../core/spend'
import { catalogNow, changesIn, domainDocsIn, isLoaded, KEPT_DECISIONS, lookAround, manualNow, oneLine } from './catalog'
import { drawPane } from './pane'
import {
  SYSTEM,
  directiveOf,
  gapsOf,
  hashOf,
  isAdvice,
  isReviewSkill,
  isSpecSkill,
  isTerse,
  kindOf,
  namesSkill,
  parseReply,
  promptOf,
  resolve,
  ruleHits,
  shortOf,
  skipOf,
  skipsQuestions,
  stageOf,
  stageSkills,
} from './route'
import type { Failure } from './route'
import {
  COMMAND,
  PANE,
  addDecision,
  feedbackIn,
  flash,
  forgetLoaded,
  grillingIn,
  loadedIn,
  markLoaded,
  modeIn,
  modeOf,
  ownSetup,
  refreshHeld,
  recordOutcome,
  registerCommand,
  saveSetup,
  setGrilling,
  setMode,
  showMode,
  setTab,
  wordsIn,
} from './state'
import { WORDS } from './words'

// The prompt waits on the model, so the model gets a short while: a pick that comes later is worth
// less than the wait. It mostly answers in one to two seconds, as it says what it reads before it
// picks; one that takes longer than three is let go, and the prompt goes as typed. One that failed
// twice in a row (offline, rate-limited, overloaded) is left to rest, so the prompts after it are not
// kept waiting on it too; once is a blip.
const MODEL_TIMEOUT_MS = 3_000
const MODEL_REST_MS = 5 * 60_000
const FAILS_TO_REST = 2

// What the router reads besides the prompt: the person's previous prompt and the end of Claude's last
// answer, so a "now the tests" is read as part of the work under way.
let previous = ''
let answer = ''
// Until when the model is not asked, after it failed; how many calls in a row failed, and how the
// last one did.
let restUntil = 0
let failsInRow = 0
let lastFailure: Failure = { kind: 'unread' }
// The decisions whose picks wait on the turn their prompt starts, each by its own `at`: the picks
// judged by it (those not loaded before) and the skills loaded in its turn. A prompt the person queued
// while a turn ran waits for the next turn (`isQueued`): the turn under way is not its, so its picks
// are not judged by what that one loaded.
type Awaiting = { at: number; judged: string[]; seen: string[]; isQueued: boolean }
let awaiting: Awaiting[] = []
// The `at` of the last decision: each prompt's is its own, two in the same millisecond too.
let lastAt = 0
// The model's verdicts this session, by the prompt and what was around it: the same prompt after the
// same answer is not asked again (sent again after an escape, or once more as it was).
const verdicts = new Map<string, string>()
const KEPT_VERDICTS = 100

type Routed = { picks: Pick[]; note?: string; failure?: Failure; stage?: Stage; gaps?: string; afterGrilling?: boolean }

async function failed($: EngineInterface, failure: Failure, canRest: boolean): Promise<Routed> {
  lastFailure = failure
  failsInRow += 1
  if (canRest && failsInRow >= FAILS_TO_REST) restUntil = (await $.clock.now()) + MODEL_REST_MS

  return { picks: [], note: 'failed', failure }
}

// What the router picks for a prompt: the person's rules first, and a rule that fires settles it,
// its skill loaded already or not; where none fires, the model, unless the prompt says too little to
// go on or the person named a skill themselves. While Claude grills the developer, the answers are
// the model's to read: a word a rule waits for is part of an answer there, and a short "давай" may end
// the grilling.
async function routeOf($: EngineInterface, text: string, useModel: boolean, model: string, signal: AbortSignal): Promise<Routed> {
  const { skills, setup } = await lookAround($)
  if (skills.length === 0) return { picks: [], note: 'no skills' }
  if (namesSkill(text, skills)) return { picks: [], note: 'named' }
  const loaded = await loadedIn($)
  const grilling = await grillingIn($)
  const fresh = (picks: Pick[]) => picks.filter(p => !isLoaded(p.skill, loaded))
  const hits = grilling === null ? ruleHits(text, setup.rules, skills) : []
  if (hits.length > 0) return fresh(hits).length > 0 ? { picks: fresh(hits) } : { picks: [], note: 'loaded' }
  if (!useModel || (isTerse(text) && grilling === null)) return { picks: [] }
  // Too short, a slash command, a reply to Claude's question: not worth the wait on the model.
  const skip = grilling === null ? skipOf(text, answer) : undefined
  if (skip !== undefined) return { picks: [], note: skip }
  // An open question for an opinion or ideas wants Claude's own reading: a skill only where one is
  // for reviewing, and then only a sure pick of one.
  const advice = grilling === null && isAdvice(text)
  if (advice && !skills.some(isReviewSkill)) return { picks: [], note: 'advice' }

  const key = hashOf(`${text}\u0000${answer}\u0000${grilling ?? ''}`)
  let said = verdicts.get(key)
  const [changes, hasDocs] = await Promise.all([changesIn($).catch(() => null), domainDocsIn($).catch(() => false)])
  if (said === undefined) {
    if ((await $.clock.now()) < restUntil) return { picks: [], note: 'resting' }
    const learned = await feedbackIn($)
    // A skill's track in this project where it has one to judge by, else over every project.
    const enough = (t: { offered: number } | undefined) => (t?.offered ?? 0) >= 3
    const tracks = skills
      .map(s => s.name)
      .map(skill => ({ skill, t: enough(learned.project.bySkill[skill]) ? learned.project.bySkill[skill] : learned.global[skill] }))
      .filter((x): x is { skill: string; t: { offered: number; taken: number } } => x.t !== undefined)
      .map(({ skill, t }) => ({ skill, ...t }))
    const prompt = promptOf(text, { skills, hints: setup.hints, loaded, changes, previous, answer, grilling, declined: learned.project.declined, tracks })
    const reply = await $.model.complete(
      {
        model,
        system: SYSTEM,
        prompt: [{ text: prompt.skills, cache: true }, { text: prompt.rest }],
        // It thinks in its reply: the line it reads the request in comes before its picks.
        maxTokens: 400,
        effort: 'low',
        timeoutMs: MODEL_TIMEOUT_MS,
      },
      { signal },
    )
    spendOn('router', reply.usage)
    if (!reply.isAnswered) {
      // Cut by the person (escape on the prompt) the model did not fail; by its time, it did.
      if (signal.aborted) return { picks: [] }
      if (reply.reason === 'aborted') return failed($, { kind: 'timeout', seconds: MODEL_TIMEOUT_MS / 1000 }, true)
      if (reply.reason === 'api-error') return failed($, { kind: 'api', status: reply.status, error: reply.error }, true)
      return failed($, { kind: 'unread' }, true)
    }
    restUntil = 0
    said = reply.text
  }
  // Not work, the answer is read whatever its picks say, or whether it has any.
  const kind = kindOf(said)
  const read = kind === undefined || kind === 'work' ? parseReply(said, skills) : []
  // An answer not read is the model's slip, not an outage: it is asked again on the next prompt.
  if (read === undefined) return failed($, { kind: 'unread' }, false)
  failsInRow = 0
  if (verdicts.size >= KEPT_VERDICTS) verdicts.delete(verdicts.keys().next().value!)
  verdicts.set(key, said)
  // An answer to Claude's questions, or a question of the person's, leaves the grilling under way.
  if (kind !== undefined && kind !== 'work') return { picks: read, note: kind }
  // Asked for an opinion, only a sure pick of a reviewing skill stands, and no stage: nothing is built.
  const picks = advice ? read.filter(p => p.fit !== 'maybe' && skills.some(s => s.name === p.skill && isReviewSkill(s))) : read
  if (advice) return picks.length > 0 ? { picks: fresh(picks) } : { picks: [], note: 'advice' }

  // The person who said to skip the questions is not grilled.
  const starts = stageOf(said) ?? 'go'
  const stage = starts === 'grill' && skipsQuestions(text) ? 'go' : starts
  const gaps = stage === 'grill' ? gapsOf(said) : undefined
  const staged = stage === 'go' ? [] : stageSkills(stage, skills, { hasSpec: changes !== null, hasDocs })
  if (staged.length > 0) {
    await setGrilling($, stage === 'grill' ? text.slice(0, 1500) : null)
    const why = stage === 'grill' ? (gaps ?? '') : ''
    return { picks: staged.map(skill => ({ skill, why, by: 'model' as const, isStage: true as const })), stage, ...(gaps ? { gaps } : {}), ...(stage === 'spec' && grilling !== null ? { afterGrilling: true } : {}) }
  }
  await setGrilling($, null)

  return { picks: fresh(picks), stage }
}

// Whether a model picks where no rule does, and which.
let useModel = true
let model = 'haiku'

export function configureRouter(options: PluginOptions) {
  useModel = options.routerUseModel !== false
  model = typeof options.routerModel === 'string' && options.routerModel.trim() !== '' ? options.routerModel.trim() : 'haiku'
}

export async function startRouter($: EngineInterface) {
  await refreshHeld($)
  if ((await modeIn($)) === 'off') await showMode($, 'off')
  await registerCommand($)
  void lookAround($).catch(() => undefined)
}

export async function promptSubmit($: Parameters<Hook<'prompt.submit'>>[0], e: Parameters<Hook<'prompt.submit'>>[1], next: Parameters<Hook<'prompt.submit'>>[2]) {
  // The person's own prompt: typed here, through Remote Control, or through an SDK host (`claude -p`,
  // the desktop app, an IDE); not a plugin's, a peer's, a notification or a scheduled run.
  const isPersons = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk'
  if (e.command || e.isMeta || !isPersons) return next(e)
  const mode = await modeIn($)
  if (mode === 'off') return next(e)

  // A prompt sent while a turn runs is queued: its turn is the next one.
  const isQueued = ownerNow() !== undefined
  const startedAt = Math.max(await $.clock.now(), lastAt + 1)
  lastAt = startedAt
  const loadedBefore = await loadedIn($).catch(() => [] as string[])
  // The router's own slip (the commands not listed, the store not read) is not the model's.
  const routed: Routed = await routeOf($, e.text, useModel, model, next.signal).catch(() => ({ picks: [] as Pick[], note: 'error' }))
  previous = e.text.slice(0, 1500)
  const ms = Math.max(0, (await $.clock.now()) - startedAt)
  const decision: Decision = {
    at: startedAt,
    prompt: oneLine(e.text, 200),
    picks: routed.picks,
    ms,
    ...(routed.note ? { note: routed.note } : {}),
    ...(routed.stage && routed.stage !== 'go' && routed.picks.some(p => p.isStage) ? { stage: routed.stage } : {}),
    ...(routed.gaps ? { gaps: routed.gaps } : {}),
  }
  const words = await wordsIn($)
  if (routed.failure) decision.why = words.failure(routed.failure)
  if (routed.note === 'resting') decision.why = words.failure(lastFailure)
  // Kept for the pane; a write refused mid-render costs the history a line, not the prompt its skill.
  await addDecision($, decision, KEPT_DECISIONS).catch(() => {})
  // The model's picks are judged by the turn this prompt starts: a skill loaded before it tells
  // nothing, a rule is the person's word, not a guess to learn from, and a maybe pick is not told.
  // A prompt sent between turns starts the next one, and what waited before it is let go; one queued
  // waits beside the turn under way.
  const told = routed.picks.filter(p => p.fit !== 'maybe')
  const judged = told.filter(p => p.by === 'model').map(p => p.skill).filter(skill => !isLoaded(skill, loadedBefore))
  const entry: Awaiting = { at: startedAt, judged, seen: [], isQueued }
  awaiting = [...(isQueued ? awaiting : []), ...(judged.length > 0 ? [entry] : [])]
  // A model that failed says so where the pick would be, and why, so no pick is not read as nothing
  // fitting; one left to rest, when it is asked again.
  const note = routed.note
  $.ui.status(
    told.length > 0
      ? words.status(`${decision.stage ? `${words.stages[decision.stage]} · ` : ''}${told.map(p => shortOf(p.skill)).join(', ')}`)
      : note === 'failed'
        ? words.status(words.failed(decision.why ?? ''))
        : note === 'resting'
          ? words.status(words.resting(decision.why ?? '', Math.ceil((restUntil - ms - startedAt) / 60_000)))
          : note === 'error'
            ? words.status(words.broken)
            : undefined,
  )
  if (told.length === 0) return next(e)
  const stage = decision.stage ? { stage: decision.stage, loaded: loadedBefore, ...(routed.gaps ? { gaps: routed.gaps } : {}), ...(routed.afterGrilling ? { afterGrilling: true } : {}) } : undefined

  return next({ ...e, context: [...(e.context ?? []), directiveOf(mode, told, stage, catalogNow())] })
}

// A skill loaded by any road (the router's word, the person's `/name`, Claude's own choice) is in the
// conversation from then on. The spec's own skill loaded ends a grilling: what it settled is written.
export async function skillPrompt($: Parameters<Hook<'skill.prompt'>>[0], e: Parameters<Hook<'skill.prompt'>>[1], next: Parameters<Hook<'skill.prompt'>>[2]) {
  const expanded = await next(e)
  const name = e.pluginName && !e.skill.includes(':') ? `${e.pluginName}:${e.skill}` : e.skill
  // Seen by the prompts whose turn this is, not by those queued for the next.
  for (const a of awaiting) if (!a.isQueued) a.seen.push(name)
  await markLoaded($, name)
  if (isSpecSkill(name)) await setGrilling($, null)

  return expanded
}

// The main turn ended: what Claude said last is read with the next prompt, and where the person's
// prompt that started it got picks, each is marked taken or not. A turn the person stopped, or that
// failed, says nothing of the picks.
export async function endRouterTurn($: EngineInterface, agentId: string | undefined, said: string, reason: string, isPersons: boolean) {
  if (agentId !== undefined) return
  if (said) answer = said.slice(-800)
  // A part's turn is not the person's prompt's: what waits on one goes on waiting, and a prompt queued
  // in it is next.
  const ours = isPersons ? awaiting.filter(a => !a.isQueued) : []
  awaiting = awaiting.filter(a => !ours.includes(a)).map(a => ({ ...a, isQueued: false }))
  if (reason !== 'answer') return
  for (const { at, judged, seen } of ours) await recordOutcome($, at, skill => isLoaded(skill, seen), judged)
}

// A compaction can drop a skill's text from the conversation, and a /clear drops everything: such a
// skill may be picked again.
export async function sessionCompact($: Parameters<Hook<'session.compact'>>[0], e: Parameters<Hook<'session.compact'>>[1], next: Parameters<Hook<'session.compact'>>[2]) {
  const compacted = await next(e)
  if (e.trigger !== 'precompute' && e.agentId === undefined && !('skip' in compacted && compacted.skip)) {
    await forgetLoaded($)
  }

  return compacted
}

// A /clear or /resume starts another conversation: nothing said before it, no skill loaded, no pick
// on the status line.
export async function clearRouter($: EngineInterface) {
  previous = ''
  answer = ''
  awaiting = []
  verdicts.clear()
  $.ui.status(undefined)
  await forgetLoaded($)
  await setGrilling($, null)
}

// Its values emptied, the mode, the setup and the skills are read again, and off says so.
export async function restoreRouter($: EngineInterface) {
  await refreshHeld($)
  await showMode($, await modeIn($))
  void lookAround($, true).catch(() => undefined)
}

export async function command($: Parameters<MatchedHook<'command.run', { command: 'router' }>>[0], e: Parameters<MatchedHook<'command.run', { command: 'router' }>>[1]) {
  const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
  const arg = rest.join(' ')
  const words = await wordsIn($)
  const mode = modeOf(verb)
  if (mode) {
    await setMode($, mode)

    return { text: words.modeSet(words.modes[mode]) }
  }
  if (verb === '' || verb === 'rules' || verb === 'skills' || verb === 'history') {
    await lookAround($).catch(() => undefined)
    await refreshHeld($)
    await setTab($, verb === '' ? 'overview' : verb)
    await flash($, null)
    await $.ui.open({ id: PANE, title: words.title, focus: true, closeOnEscape: true })

    return { text: words.opened }
  }
  // The skills as installed now, whatever the mode: a skill installed while the router was off is
  // found, and the project's own left-out ones are known.
  const around = await lookAround($).catch(() => undefined)
  const byProject = around?.project.ignored ?? []
  if (verb === 'list') {
    const own = await ownSetup($)
    const lines = catalogNow().map(s => {
      const isOut = own.ignored.includes(s.name) || byProject.includes(s.name)

      return `${isOut ? '✗' : '·'} ${s.name} — ${oneLine(s.description, 80)}${byProject.includes(s.name) ? ` (${words.leftOutByProject})` : ''}`
    })
    const yours = manualNow().map(s => `− ${s.name} — ${oneLine(s.description, 80)} (${words.yoursToRun(s.name)})`)

    return { text: words.list([...lines, ...yours]) }
  }

  const own = await ownSetup($)

  if (verb === 'rm') {
    const n = Number(arg)
    if (!Number.isInteger(n) || n < 1 || n > own.rules.length) return { text: words.noSuchRule(arg) }
    await saveSetup($, { ...own, rules: own.rules.filter((_, i) => i !== n - 1) })

    return { text: words.removed(n) }
  }

  if (verb === 'add' || verb === 'when' || verb === 'ignore' || verb === 'unignore') {
    const [name = '', ...tail] = rest
    const skill = resolve(name, catalogNow())
    const yours = skill === undefined ? resolve(name, manualNow()) : undefined
    if (yours !== undefined) return { text: words.notLoadable(yours) }
    if (skill === undefined) return { text: words.unknownSkill(name) }
    const said = tail.join(' ').trim()
    if (verb === 'add') {
      const when = said.split(',').map(w => w.trim()).filter(Boolean)
      if (when.length === 0) return { text: words.usage }
      await saveSetup($, { ...own, rules: [...own.rules, { skill, when }] })

      return { text: words.added(shortOf(skill), when.join(', ')) }
    }
    if (verb === 'when') {
      if (said === '') return { text: words.usage }
      await saveSetup($, { ...own, hints: { ...own.hints, [skill]: said } })

      return { text: words.hinted(shortOf(skill)) }
    }
    if (verb === 'unignore' && byProject.includes(skill)) return { text: words.ignoredByProject(shortOf(skill)) }
    const ignored = own.ignored.filter(s => s !== skill)
    await saveSetup($, { ...own, ignored: verb === 'ignore' ? [...ignored, skill] : ignored })

    return { text: verb === 'ignore' ? words.ignoredNow(shortOf(skill)) : words.unignoredNow(shortOf(skill)) }
  }

  return { text: words.usage }
}

// Skill names after `/router add`, `when`, `ignore`, `unignore`: the short name where it is unique.
export async function promptAutocomplete($: Parameters<Hook<'prompt.autocomplete'>>[0], e: Parameters<Hook<'prompt.autocomplete'>>[1], next: Parameters<Hook<'prompt.autocomplete'>>[2]) {
  const offered = await next(e)
  const typed = /^\/router\s+(?:add|when|ignore|unignore)\s+(\S*)$/.exec(e.text.slice(0, e.cursor))
  if (typed === null) return offered
  if (catalogNow().length === 0) await lookAround($).catch(() => undefined)
  const start = (typed[1] ?? '').toLowerCase()
  const mine = catalogNow()
    .filter(s => s.name.toLowerCase().startsWith(start) || shortOf(s.name).toLowerCase().startsWith(start))
    .slice(0, 8)
    .map(s => {
      const short = shortOf(s.name)

      return { text: resolve(short, catalogNow()) === s.name ? short : s.name, description: oneLine(s.description, 60) }
    })

  return { suggestions: [...offered.suggestions, ...mine] }
}

export async function pane($: Parameters<PaneHook>[0], e: Parameters<PaneHook>[1]) {
  // The pane's own width, not the terminal's: it may sit beside the chat.
  return drawPane($, $.ui.resolve(e), { columns: e.props.bodyColumns, rows: e.viewport?.rows ?? 24, surface: e.surface })
}
