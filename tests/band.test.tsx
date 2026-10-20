import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// The band above the prompt as the mods of one session share it: inline plugins stand in for
// context-bar-compact above agent-lens (the prepend tier) and for pyrus-inbox and stand beneath it,
// each only as it draws its rows, copied in shape from their own code.

const BAND = {
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 }, view: {} },
}
const DOOR = {
  'proposal.md': '# Proposal\n\nLet managers grant door access.\n',
  'tasks.md': '# Tasks\n\n- [x] 1.1 Add the endpoint\n- [ ] 1.2 Cover it\n',
}

// context-bar-compact: its bar, then what the plugins beneath drew.
const BAR = {
  name: 'bar',
  tier: 'prepend' as const,
  register(on: any) {
    on('ui.render', { component: 'AbovePrompt' }, async ($: any, e: any, next: any) => {
      const { Box, Text } = $.ui.resolve(e)
      const below = await next(e)
      return (
        <Box flexDirection="column">
          <Text key="bar">bar</Text>
          {below}
        </Box>
      )
    })
  },
}
// pyrus-inbox and stand: a row each whatever room the band has, then what is beneath. An inline
// plugin's register is read on its own, so each spells its row out.
const PYRUS = {
  name: 'pyrus',
  register(on: any) {
    on('ui.render', { component: 'AbovePrompt' }, async ($: any, e: any, next: any) => {
      const { Box, Text } = $.ui.resolve(e)
      const below = await next(e)
      return (
        <Box flexDirection="column">
          <Text key="pyrus">pyrus</Text>
          {below}
        </Box>
      )
    })
  },
}
const STAND = {
  name: 'stand',
  register(on: any) {
    on('ui.render', { component: 'AbovePrompt' }, async ($: any, e: any, next: any) => {
      const { Box, Text } = $.ui.resolve(e)
      const below = await next(e)
      return (
        <Box flexDirection="column">
          <Text key="stand">stand</Text>
          {below}
        </Box>
      )
    })
  },
}

const world = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) => {
  const disk = new Map<string, string>()
  for (const [f, t] of Object.entries(DOOR)) disk.set(`/proj/openspec/changes/door/${f}`, t)
  const isDir = (p: string) => [...disk.keys()].some(k => k.startsWith(`${p.replace(/\/$/, '')}/`))
  mock.clock(on, { now: 10_000 })
  const store = new Map<string, unknown>()
  on('session.root', () => ({ value: '/proj' }))
  on('fs.exists', ($, e) => ({ value: disk.has(e.path) || isDir(e.path) }))
  on('fs.list', ($, e) => {
    const dir = e.path.replace(/\/$/, '')
    const names = new Map<string, 'file' | 'dir'>()
    for (const p of disk.keys())
      if (p.startsWith(`${dir}/`)) {
        const [name, ...rest] = p.slice(dir.length + 1).split('/')
        names.set(name!, rest.length > 0 ? 'dir' : 'file')
      }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 1, isLink: false })) }
  })
  on('fs.read', ($, e) => ({ value: disk.get(e.path) ?? '' }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', ($, e) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('command.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('process.run', () => ({ deny: 'spawn openspec ENOENT' }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
}

// The rows of a drawn band, in document order: each Text or row Box keyed or labelled by its text.
const rowsOf = (node: any): string[] => {
  if (!node || typeof node !== 'object') return []
  if (node.props?.key === 'lens-row' || node.props?.key === 'review-row') return [node.props.key]
  if (node.props?.key === 'engine') return ['engine']
  if (node.type === 'Text') return [(node.children ?? []).join('')]
  return ((node.children ?? []) as unknown[]).flatMap(rowsOf)
}

test('the lens row sits under the bars above it and over the rows of the mods beneath, in view of a short band', { plugins: [BAR, PYRUS, STAND] }, async ($, on) => {
  await world($, on)
  const maxRows = 3
  const ui = await $.ui.mount({ plugin: 'agent-lens', surface: 'terminal', ...BAND, props: { ...BAND.props, maxRows, scroll: { offset: 0, bodyRows: maxRows - 1 } } })
  expect(rowsOf(await ui.drawn()).filter(r => r !== 'engine')).toEqual(['bar', 'lens-row', 'pyrus', 'stand'])
  await ui.unmount()
})
