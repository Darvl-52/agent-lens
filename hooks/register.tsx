import type { Hook, Register, RenderChildren } from 'claude-code'

import { configureLang, restoreLang } from './core/lang'
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
import { PANE as ROUTER_PANE } from './router/state'
import { langCommand } from './switch'
import { afterSpecEdit, configureSpec, endSpecAgent, endSpecTurn, openPane as openSpec, rescanSpec, PANE as SPEC_PANE, command as specCommand, pane as specPane, specLine, startSpec, startSpecTurn } from './spec/lens'

// Three parts in one module, each in its own folder, sharing the language: the review of what the
// agent changed (with the check of each edit as it is made), the OpenSpec change in view, and the
// skill each prompt gets. Every hook is registered here; on an event more than one part hears,
// each part's work runs in turn, and one that fails does not stop the others.
// Between the spec's part of the row and the review's; and the columns the spec keeps for itself
// there, its name and a part or two, below which each goes on a row of its own.
const SPLIT = '  │  '
const MIN_SPEC = 40

// What every part shows, read back into values a /clear or /resume emptied: the language, the change
// in view, the router's mode, setup and skills.
async function readBack($: Parameters<Hook<'session.end'>>[0]) {
  await restoreLang($).catch(() => {})
  await rescanSpec($).catch(() => {})
  await restoreRouter($).catch(() => {})
}

export const register: Register = (on, options) => {
  configureLang(options)
  configureReview(options)
  configureSpec(options)
  configureRouter(options)

  on('session.start', async ($, e, next) => {
    await restoreLang($).catch(() => {})
    await startReview($).catch(() => {})
    await startSpec($, e.isInteractive).catch(() => {})
    const started = await next(e)
    await startRouter($).catch(() => {})
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
  on('prompt.submit', ($, e, next) => promptSubmit($, e, next))
  on('prompt.autocomplete', ($, e, next) => promptAutocomplete($, e, next))
  on('skill.prompt', ($, e, next) => skillPrompt($, e, next))
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) startSpecTurn()
    return turnStart($, e, next)
  })

  on('turn.complete', async ($, e, next) => {
    endRouterTurn(e.agentId, e.answer)
    if (e.agentId === undefined) endSpecTurn($)
    else endSpecAgent($, e.agentId, e.answer)
    const result = await next(e)
    await endReviewTurn($, e.agentId, e.reason).catch(() => {})
    return result
  })

  // Every edit, a subagent's too, is taken before it runs: what the file was is what the turn and
  // the session are compared with.
  on('tool.call', { tool: 'Write' }, ($, e, next) => beforeWrite($, e, next)).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Edit' }, ($, e, next) => beforeEdit($, e, next)).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'NotebookEdit' }, ($, e, next) => beforeNotebookEdit($, e, next)).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Bash' }, ($, e, next) => aroundShell($, e, next)).catch(($, e, next) => next(e))

  // Then each edit is checked against the rules, and the spec read again where the edit was to it.
  on('tool.call', async ($, e, next) => {
    const refusal = await checkBefore($, e).catch(() => undefined)
    if (refusal !== undefined) return { deny: refusal }
    const ran = await next(e)
    if ((e.tool === 'Write' || e.tool === 'Edit') && !ran.isError) afterSpecEdit($, e.file_path)
    return checkAfter($, e, ran)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', ($, e, next) => classicStop($, e, next)).catch(($, e, next) => next(e))
  on('classic.SubagentStop', ($, e, next) => classicSubagentStop($, e, next)).catch(($, e, next) => next(e))

  // `lang` after any of them switches every part.
  on('command.run', { command: 'changes' }, async ($, e) => (await langCommand($, 'changes', e.args)) ?? reviewCommand($, e))
  on('command.run', { command: 'spec' }, async ($, e) => (await langCommand($, 'spec', e.args)) ?? specCommand($, e))
  on('command.run', { command: 'router' }, async ($, e) => (await langCommand($, 'router', e.args)) ?? routerCommand($, e))

  // One row above the prompt: the OpenSpec change in view, then what the agent's last turn changed,
  // each opening its pane. Where the change cannot keep its name beside the turn, each has a row.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || e.props.maxRows < 2) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    const review = await reviewLine($, e).catch(() => null)
    const reviewButton = <Button key="open-changes" label="/changes" plain dimColor onPress={() => void openReview($).catch(() => {})} />
    const specButton = <Button key="open-spec" label="/spec" plain dimColor onPress={() => void openSpec($).catch(() => {})} />
    // Whether the spec keeps its room beside the review is settled first: on a row of its own it
    // is laid out for the whole row, not squeezed as if the review were still beside it.
    const taken = review ? ' /spec /changes'.length + SPLIT.length + review.width : ' /spec'.length
    const fits = review !== null && e.props.bodyColumns - taken >= MIN_SPEC
    const spec = await specLine($, e, fits ? taken : ' /spec'.length).catch(() => null)
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
    if (rows.length === 0) return below
    return (
      <Box flexDirection="column">
        {below}
        {rows}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: REVIEW_PANE }, ($, e) => reviewPane($, e))
  on('ui.render', { component: 'Pane', requestId: SPEC_PANE }, ($, e) => specPane($, e))
  on('ui.render', { component: 'Pane', requestId: ROUTER_PANE }, ($, e) => routerPane($, e))
}
