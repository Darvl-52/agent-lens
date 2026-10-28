import type { Hook, Register, RenderChildren } from 'claude-code'

import type { Part } from '../types'
import type { StopNext } from './core/hooks'

import { configureLang, restoreLang } from './core/lang'
import { checkedGuard, clearGuard, configureGuard, endGuardTurn, guardAfter, guardBefore, guardCommand, guardLines, restoreGuard, startGuardTurn } from './guard/guard'
import {
  aroundShell,
  beforeEdit,
  beforeNotebookEdit,
  beforeWrite,
  checkAfter,
  checkBefore,
  classicStop,
  classicSubagentStop,
  configureReview,
  endReviewTurn,
  PANE as REVIEW_PANE,
  command as reviewCommand,
  pane as reviewPane,
  openPane as openReview,
  restartReview,
  reviewLine,
  startReview,
  turnStart,
} from './review/review'
import {
  clearRouter,
  configureRouter,
  endRouterTurn,
  promptAutocomplete,
  promptSubmit,
  restoreRouter,
  command as routerCommand,
  pane as routerPane,
  sessionCompact,
  skillPrompt,
  startRouter,
} from './router/router'
import { PANE as ROUTER_PANE, registerCommand as registerRouterCommand } from './router/state'
import { addTaskRules, afterSetupEdit, dismissRetro, dismissTaskRules, endSetupAgent, endSetupTurn, gateStop, judgeReport, registerSetup, retroLine, rulesLine, runRetro, openSetup, PANE as SETUP_PANE, pane as setupPane, setupCommand, setupLine, startSetup, startSetupTurn } from './setup/setup'
import { configureLenses, dismissOffer, endLensAgent, lensesBeforePush, lensesCommand, lensesLine, lensReport, offerLine, openPane as openLenses, PANE as LENSES_PANE, pane as lensesPane, runOffered } from './lenses/lenses'
import { isOn, offText, PARTS, PANE as PARTS_PANE, registerCommand as registerPartsCommand, restoreParts } from './parts/parts'
import { command as partsCommand, pane as partsPane } from './parts/menu'
import { langCommand } from './switch'
import { afterSpecEdit, configureSpec, endSpecAgent, endSpecTurn, criticReport, openPane as openSpec, registerCommand as registerSpecCommand, rescanSpec, PANE as SPEC_PANE, command as specCommand, pane as specPane, specLine, startSpec, startSpecTurn } from './spec/lens'

// Four parts in one module, each in its own folder, sharing the language: the review of what the
// agent changed (with the check of each edit as it is made), the OpenSpec change in view, the
// skill each prompt gets, and the guard that holds each agent's turn to its limits. Every hook is registered here; on an event more than one part hears,
// each part's work runs in turn, and one that fails does not stop the others.
// Between the spec's part of the row and the review's; and the columns the spec keeps for itself
// there, its name and a part or two, below which each goes on a row of its own.
const SPLIT = '  │  '
const MIN_SPEC = 40

// The parts on as each loop's turn started: its end is a part's only where its start was, so a part
// switched in the menu mid-turn does not end a turn it never began, nor leave one it began open.
const begun = new Map<string, readonly Part[]>()
const MAIN = ''

// What every part shows, read back into values a /clear or /resume emptied: the language, the change
// in view, the router's mode, setup and skills.
async function readBack($: Parameters<Hook<'session.end'>>[0]) {
  await restoreLang($).catch(() => {})
  await restoreParts($).catch(() => {})
  if (isOn('spec')) await rescanSpec($).catch(() => {})
  if (isOn('router')) await restoreRouter($).catch(() => {})
  await restoreGuard($).catch(() => {})
  if (isOn('setup')) await startSetup($).catch(() => {})
}

// What the person is told such a report went to, or undefined for any other text.
async function agentReport($: Parameters<Hook<'prompt.submit'>>[0], text: string) {
  // The docs agent and the lenses first: the critic's check knows every agent this mod started.
  return (await judgeReport($, text).catch(() => undefined)) ?? (await lensReport($, text).catch(() => undefined)) ?? (await criticReport($, text).catch(() => undefined))
}

export const register: Register = (on, options) => {
  configureLang(options)
  configureReview(options)
  configureSpec(options)
  configureRouter(options)
  configureGuard(options)
  configureLenses(options)

  // A part turned off in /agent-lens still has its command, which says so, and does none of its work.
  on('session.start', async ($, e, next) => {
    await restoreLang($).catch(() => {})
    await restoreParts($).catch(() => {})
    await restoreGuard($).catch(() => {})
    await registerPartsCommand($).catch(() => {})
    await startReview($).catch(() => {})
    await (isOn('spec') ? startSpec($, e.isInteractive) : registerSpecCommand($)).catch(() => {})
    await (isOn('setup') ? startSetup($) : registerSetup($)).catch(() => {})
    const started = await next(e)
    await (isOn('router') ? startRouter($) : registerRouterCommand($)).catch(() => {})
    return started
  })

  // A /clear or /resume starts a conversation with its values emptied and no session.start. The old
  // one's end drops what each part's module kept of it; its values are emptied after that end, so
  // what the parts show is read back on the classic SessionStart that follows. Where an organization
  // manages Claude Code no classic hook runs: the end reads it back too, for as long as it lasts.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason === 'clear' || e.reason === 'resume') {
      await restartReview($).catch(() => {})
      await clearRouter($).catch(() => {})
      await clearGuard($).catch(() => {})
      await readBack($)
    }
    return ended
  })

  on('classic.SessionStart', async ($, e, next) => {
    const started = await next(e)
    if (e.source === 'clear' || e.source === 'resume') await readBack($)
    return started
  }).catch(($, e, next) => next(e))

  on('session.compact', ($, e, next) => sessionCompact($, e, next))
  // The report of an agent this mod started (the spec critic, the docs agent) is its pane's, not a
  // message for Claude: the engine queues a subagent's hand-back to the main conversation as a
  // peer's prompt, and a delivery from outside the session reaches session.receive.
  on('prompt.submit', async ($, e, next) => {
    const kept = e.origin.kind === 'peer' ? await agentReport($, e.text) : undefined
    return kept ? { drop: kept } : isOn('router') ? promptSubmit($, e, next) : next(e)
  })
  on('prompt.autocomplete', ($, e, next) => (isOn('router') ? promptAutocomplete($, e, next) : next(e)))
  on('skill.prompt', ($, e, next) => skillPrompt($, e, next))
  on('turn.start', async ($, e, next) => {
    begun.set(e.agentId ?? MAIN, PARTS.filter(isOn))
    if (e.agentId === undefined) {
      if (isOn('spec')) startSpecTurn()
      if (isOn('setup')) startSetupTurn($, e.text)
    }
    if (isOn('guard')) await startGuardTurn($, e.agentId).catch(() => {})
    return isOn('review') ? turnStart($, e, next) : next(e)
  })

  on('session.receive', async ($, e, next) => {
    const kept = e.agentId === undefined && e.origin.kind === 'peer' ? await agentReport($, e.text) : undefined
    return kept ? { consumed: kept } : next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A turn whose start this module missed (a reload) ends as the switches are now.
    const began = (part: Part) => begun.get(e.agentId ?? MAIN)?.includes(part) ?? isOn(part)
    endRouterTurn(e.agentId, e.answer)
    if (e.agentId === undefined) {
      if (began('spec')) endSpecTurn($, e.reason)
      if (began('setup')) endSetupTurn($, e.reason)
    } else {
      endSpecAgent($, e.agentId, e.answer)
      void endSetupAgent($, e.agentId, e.answer).catch(() => {})
      void endLensAgent($, e.agentId, e.answer).catch(() => {})
    }
    await endGuardTurn($, e.agentId).catch(() => {})
    const result = await next(e)
    if (began('review')) await endReviewTurn($, e.agentId, e.reason).catch(() => {})
    begun.delete(e.agentId ?? MAIN)
    return result
  })

  // What the guard learns of a permission put to the person keeps their wait out of the agent's time.
  on('tool.check', async ($, e, next) => {
    const checked = await next(e)
    if (isOn('guard')) checkedGuard(e.tool_use_id, checked.decision)
    return checked
  })

  // Every edit, a subagent's too, is taken before it runs: what the file was is what the turn and
  // the session are compared with.
  on('tool.call', { tool: 'Write' }, ($, e, next) => (isOn('review') ? beforeWrite($, e, next) : next(e))).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Edit' }, ($, e, next) => (isOn('review') ? beforeEdit($, e, next) : next(e))).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'NotebookEdit' }, ($, e, next) => (isOn('review') ? beforeNotebookEdit($, e, next) : next(e))).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Bash' }, ($, e, next) => (isOn('review') ? aroundShell($, e, next) : next(e))).catch(($, e, next) => next(e))

  // Then the guard holds the call to its loop's limits; each edit is checked against the rules, and
  // the spec read again where the edit was to it.
  on('tool.call', async ($, e, next) => {
    const held = isOn('guard') ? await guardBefore($, e).catch(() => undefined) : undefined
    if (held?.deny !== undefined) return { deny: held.deny }
    const refusal = isOn('review') ? await checkBefore($, e).catch(() => undefined) : undefined
    if (refusal !== undefined) return { deny: refusal }
    // In Lenses: auto, work not read through the lenses since the last push waits for them.
    const unread = e.tool === 'Bash' && isOn('lenses') ? await lensesBeforePush($, e.command, e.agentId).catch(() => undefined) : undefined
    if (unread !== undefined) return { deny: unread }
    const ran = await next(e)
    if ((e.tool === 'Write' || e.tool === 'Edit') && !ran.isError) {
      if (isOn('spec')) afterSpecEdit($, e.file_path)
      if (isOn('setup')) afterSetupEdit($, e.file_path)
    }
    const checked = isOn('review') ? checkAfter($, e, ran) : ran
    return guardAfter($, e, held, checked).catch(() => checked)
  }).catch(($, e, next) => next(e))

  // The review's notes wait while the gate keeps the turn going: red code is fixed before it is read.
  on('classic.Stop', ($, e, next) => {
    const gate: StopNext = ev => (isOn('setup') ? gateStop($, ev, next) : next(ev))
    return isOn('review') ? classicStop($, e, gate) : gate(e)
  }).catch(($, e, next) => next(e))
  on('classic.SubagentStop', ($, e, next) => (isOn('review') ? classicSubagentStop($, e, next) : next(e))).catch(($, e, next) => next(e))

  // `lang` after any of them switches every part.
  // A part turned off answers its verb with where to turn it on.
  on('command.run', { command: 'changes' }, async ($, e) => {
    const verb = e.args.trim().split(/\s+/)[0]?.toLowerCase()
    const part = verb === 'guard' ? 'guard' : verb === 'lenses' ? 'lenses' : 'review'
    if (verb !== 'lang' && !isOn(part)) return offText($, part)
    return (await langCommand($, 'changes', e.args)) ?? (await guardCommand($, e.args)) ?? (await lensesCommand($, e.args)) ?? reviewCommand($, e)
  })
  on('command.run', { command: 'spec' }, async ($, e) => (await langCommand($, 'spec', e.args)) ?? (isOn('spec') ? specCommand($, e) : offText($, 'spec')))
  on('command.run', { command: 'setup-project' }, ($, e) => (isOn('setup') ? setupCommand($, e.args) : offText($, 'setup')))
  on('command.run', { command: 'router' }, async ($, e) => (await langCommand($, 'router', e.args)) ?? (isOn('router') ? routerCommand($, e) : offText($, 'router')))
  on('command.run', { command: 'agent-lens' }, $ => partsCommand($))

  // One row above the prompt: the OpenSpec change in view, then what the agent's last turn changed,
  // each opening its pane. Where the change cannot keep its name beside the turn, each has a row.
  // They go before what the plugins beneath drew: a band taller than its room scrolls from the top,
  // and rows of theirs that do not count their room would push these out of view.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || e.props.maxRows < 2) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    const review = isOn('review') ? await reviewLine($, e).catch(() => null) : null
    const reviewButton = <Button key="open-changes" label="/changes" plain dimColor onPress={() => void openReview($).catch(() => {})} />
    const specButton = <Button key="open-spec" label="/spec" plain dimColor onPress={() => void openSpec($).catch(() => {})} />
    // Whether the spec keeps its room beside the review is settled first: on a row of its own it
    // is laid out for the whole row, not squeezed as if the review were still beside it.
    const taken = review ? ' /spec /changes'.length + SPLIT.length + review.width : ' /spec'.length
    const fits = review !== null && e.props.bodyColumns - taken >= MIN_SPEC
    const spec = isOn('spec') ? await specLine($, e, fits ? taken : ' /spec'.length).catch(() => null) : null
    const row = (key: string, items: RenderChildren, buttons: RenderChildren) => (
      <Box key={key} flexDirection="row" gap={1} justifyContent="space-between">
        <Box flexDirection="row" flexShrink={1} overflow="hidden">
          {items}
        </Box>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          {buttons}
        </Box>
      </Box>
    )
    const rows =
      spec && review && fits
        ? [row('lens-row', [...spec, <Text dimColor>{SPLIT}</Text>, review.item], [specButton, reviewButton])]
        : [...(spec ? [row('lens-row', spec, specButton)] : []), ...(review ? [row('review-row', review.item, reviewButton)] : [])]
    // An agent past the guard's soft limit goes first, a row of its own: it is what wants a look now.
    const guarded = (isOn('guard') ? await guardLines($).catch(() => []) : []).map((g, i) => (
      <Text key={`guard-row-${i}`} color={g.isStopped ? 'error' : 'warning'} wrap="truncate-end">
        {g.text}
      </Text>
    ))
    const retro = isOn('setup') ? await retroLine($).catch(() => null) : null
    if (retro)
      rows.unshift(
        row('retro-row', <Text color="warning">{retro}</Text>, [
          <Button key="run-retro" label="/retro" plain onPress={() => void runRetro($).catch(() => {})} />,
          <Button key="dismiss-retro" label="×" plain dimColor onPress={() => void dismissRetro($).catch(() => {})} />,
        ]),
      )
    const rules = isOn('setup') ? await rulesLine($).catch(() => null) : null
    if (rules)
      rows.unshift(
        row('rules-offer-row', <Text color="warning">{rules}</Text>, [
          <Button key="add-rules" label="add" plain onPress={() => void addTaskRules($).catch(() => {})} />,
          <Button key="dismiss-rules" label="×" plain dimColor onPress={() => void dismissTaskRules($).catch(() => {})} />,
        ]),
      )
    const offered = isOn('lenses') ? await offerLine($).catch(() => null) : null
    if (offered)
      rows.unshift(
        row('lenses-offer-row', <Text color="warning">{offered}</Text>, [
          <Button key="run-lenses" label="/changes lenses" plain onPress={() => void runOffered($).catch(() => {})} />,
          <Button key="dismiss-lenses" label="×" plain dimColor onPress={() => void dismissOffer($).catch(() => {})} />,
        ]),
      )
    const lenses = isOn('lenses') ? await lensesLine($).catch(() => null) : null
    if (lenses) rows.unshift(row('lenses-row', <Text color="warning">{lenses}</Text>, <Button key="open-lenses" label="/changes lenses" plain dimColor onPress={() => void openLenses($).catch(() => {})} />))
    const docs = isOn('setup') ? await setupLine($).catch(() => null) : null
    if (docs) rows.unshift(row('setup-row', <Text color="warning">{docs}</Text>, <Button key="open-setup" label="/setup-project" plain dimColor onPress={() => void openSetup($).catch(() => {})} />))
    rows.unshift(...guarded)
    if (rows.length === 0) return below
    return (
      <Box flexDirection="column">
        {rows}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: REVIEW_PANE }, ($, e) => reviewPane($, e))
  on('ui.render', { component: 'Pane', requestId: SPEC_PANE }, ($, e) => specPane($, e))
  on('ui.render', { component: 'Pane', requestId: ROUTER_PANE }, ($, e) => routerPane($, e))
  on('ui.render', { component: 'Pane', requestId: SETUP_PANE }, ($, e) => setupPane($, e))
  on('ui.render', { component: 'Pane', requestId: LENSES_PANE }, ($, e) => lensesPane($, e))
  on('ui.render', { component: 'Pane', requestId: PARTS_PANE }, ($, e) => partsPane($, e))
}
