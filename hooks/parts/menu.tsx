import type { EngineInterface } from 'claude-code'

import type { Part } from '../../types'
import type { PaneHook } from '../core/hooks'
import { startRouter } from '../router/router'
import { startSetup } from '../setup/setup'
import { startSpec } from '../spec/lens'
import { type Autonomy, autonomyNow, openDecide, setAutonomy } from '../ledger/ledger'
import { guardCommand } from '../guard/guard'
import { openPane as openLenses } from '../lenses/lenses'
import { WORDS as LEDGER_WORDS } from '../ledger/words'
import { langIn } from '../core/lang'
import { budgetNow, spentNow } from '../core/spend'
import { faultsNow } from '../core/faults'
import { autoNow } from '../core/outbox'
import { PARTS, PANE, isSwitchedOn, offIn, setPart, wordsIn } from './parts'

const AUTONOMY: readonly Autonomy[] = ['manual', 'auto', 'full']

// A part turned on mid-session does what it would have done at the start: its row is read and its
// command said again; one turned off leaves nothing of its own on the status line.
async function toggle($: EngineInterface, part: Part) {
  const isOnNow = !isSwitchedOn(part)
  await setPart($, part, isOnNow)
  if (part === 'spec' && isOnNow) await startSpec($, true).catch(() => {})
  if (part === 'setup' && isOnNow) await startSetup($).catch(() => {})
  if (part === 'router' && isOnNow) await startRouter($).catch(() => {})
  if (part === 'router' && !isOnNow) $.ui.status(undefined)
  const words = await wordsIn($)
  await $.ui.toast(words.turned(words.parts[part].name, isOnNow))
}

// The guard's limits and what runs now, as /changes guard says them.
async function showGuard($: EngineInterface) {
  const said = await guardCommand($, 'guard')
  if (said) await $.ui.toast(said.text)
}

export async function command($: EngineInterface) {
  const words = await wordsIn($)
  const { isPlaced } = await $.ui.open({ id: PANE, title: words.title, focus: true, closeOnEscape: true })
  if (isPlaced) return { text: words.opened }
  const off = await offIn($)

  return { text: words.list(PARTS.map(p => `${off.includes(p) ? words.off : words.on} ${words.parts[p].name}`)) }
}

export async function pane($: Parameters<PaneHook>[0], e: Parameters<PaneHook>[1]) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const words = await wordsIn($)
  const off = await offIn($)
  const reviewOff = off.includes('review')
  const ledger = LEDGER_WORDS[await langIn($)]
  const spent = spentNow()
  const budget = budgetNow()
  const faults = faultsNow()
  const auto = autoNow()

  return (
    <Box flexDirection="column">
      {PARTS.map((p, i) => {
        const isOff = off.includes(p)
        const isMuted = p === 'live' && reviewOff

        return (
          <Box key={`part-${p}`} flexDirection="row" gap={1}>
            <Text>{p === 'live' ? '  └' : ''}</Text>
            <Button key={`toggle-${p}`} plain hotkey={String(i + 1)} label={isOff ? words.off : words.on} dimColor={isOff || isMuted} onPress={() => toggle($, p)} />
            <Text bold={!isOff && !isMuted} dimColor={isOff || isMuted}>
              {words.parts[p].name}
            </Text>
            <Text dimColor wrap="truncate-end">
              {words.parts[p].what}
            </Text>
          </Box>
        )
      })}
      <Box key="autonomy" flexDirection="row" gap={1}>
        <Button key="toggle-autonomy" plain hotkey="a" label={`${ledger.autonomy}:`} onPress={() => void setAutonomy($, AUTONOMY[(AUTONOMY.indexOf(autonomyNow()) + 1) % AUTONOMY.length]!).catch(() => {})} />
        <Text dimColor wrap="truncate-end">
          {ledger.modes[autonomyNow()]}
        </Text>
      </Box>
      <Box key="open" flexDirection="row" gap={2}>
        <Button key="open-decide" plain hotkey="d" label={words.openDecide} onPress={() => void openDecide($).catch(() => {})} />
        <Button key="open-lenses" plain hotkey="l" label={words.openLenses} onPress={() => void openLenses($).catch(() => {})} />
        <Button key="show-guard" plain hotkey="g" label={words.showGuard} onPress={() => void showGuard($).catch(() => {})} />
      </Box>
      {spent.length > 0 || faults.length > 0 || auto.used > 0 || auto.isHeld ? (
        <Box key="spent" flexDirection="column" marginTop={1}>
          <Text bold>{words.spentTitle}</Text>
          {spent.map(([part, s]) => (
            <Text key={`spent-${part}`} dimColor wrap="truncate-end">
              {words.spent((PARTS as readonly string[]).includes(part) ? words.parts[part as Part].name : part === 'ledger' ? words.ledgerName : part, s.fresh, s.cached, s.calls, s.turns)}
            </Text>
          ))}
          {budget.budget > 0 ? <Text color={budget.isOver ? 'warning' : undefined} dimColor={!budget.isOver}>{words.budget(budget.fresh, budget.budget, budget.isOver)}</Text> : null}
          <Text key="auto" dimColor wrap="truncate-end">
            {words.auto(auto.used, auto.max, auto.isHeld)}
          </Text>
          {faults.map(([part, f]) => (
            <Text key={`fault-${part}`} dimColor wrap="truncate-end">
              {words.fault(part, f.count, f.last)}
            </Text>
          ))}
        </Box>
      ) : null}
      <Text dimColor>{words.keysHelp(PARTS.length)}</Text>
    </Box>
  )
}
