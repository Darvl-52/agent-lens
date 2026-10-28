import type { EngineInterface } from 'claude-code'

import type { Part } from '../../types'
import type { PaneHook } from '../core/hooks'
import { startRouter } from '../router/router'
import { startSetup } from '../setup/setup'
import { startSpec } from '../spec/lens'
import { PARTS, PANE, isSwitchedOn, offIn, setPart, wordsIn } from './parts'

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
      <Text dimColor>{words.keysHelp(PARTS.length)}</Text>
    </Box>
  )
}
