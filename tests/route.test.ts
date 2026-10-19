import { expect, test } from 'claude-code/testing'
import type { CommandInfo } from 'claude-code'

import {
  catalogOf,
  directiveOf,
  isTerse,
  join,
  merge,
  namesSkill,
  parseReply,
  patternOf,
  progressOf,
  promptOf,
  resolve,
  resolveSetup,
  ruleHits,
  setupOf,
} from '../hooks/router/route'

const COMMANDS: CommandInfo[] = [
  { name: 'mattpocock-skills:tdd', description: 'Test-driven development.', source: 'plugin', plugin: 'mattpocock-skills' },
  { name: 'mattpocock-skills:diagnosing-bugs', description: 'Diagnosis loop for hard bugs.', source: 'plugin', plugin: 'mattpocock-skills' },
  { name: 'other:tdd-lite', description: 'A lighter TDD.', source: 'plugin', plugin: 'other' },
  { name: 'docs', description: 'Living docs.', source: 'user' },
  { name: 'context-bar', description: 'Toggle the context bar.', source: 'plugin', plugin: 'context-bar-compact' },
  { name: 'help', description: 'Help.', source: 'builtin' },
  { name: 'figma:prompt', description: 'An MCP prompt.', source: 'mcp' },
]
const SKILLS = catalogOf(COMMANDS, [])

test('the catalog is the skills the Skill tool runs: user ones and prefixed plugin ones', () => {
  expect(SKILLS.map(s => s.name)).toEqual(['mattpocock-skills:tdd', 'mattpocock-skills:diagnosing-bugs', 'other:tdd-lite', 'docs'])
  expect(catalogOf(COMMANDS, ['docs']).map(s => s.name)).not.toContain('docs')
})

test('a short name means the one skill that ends in it', () => {
  expect(resolve('tdd', SKILLS)).toBe('mattpocock-skills:tdd')
  expect(resolve('/diagnosing-bugs', SKILLS)).toBe('mattpocock-skills:diagnosing-bugs')
  expect(resolve('docs', SKILLS)).toBe('docs')
  expect(resolve('nope', SKILLS)).toBeUndefined()
  const twice = catalogOf([...COMMANDS, { name: 'x:tdd', description: '', source: 'plugin' }], [])
  expect(resolve('tdd', twice)).toBeUndefined()
})

test('a rule word matches at the start of a word in any case, a /regex/ as written', () => {
  expect(patternOf('тест')?.test('Напиши тесты для корзины')).toBe(true)
  expect(patternOf('test')?.test('the latest build')).toBe(false)
  expect(patternOf('test')?.test('Tests first')).toBe(true)
  expect(patternOf('red green')?.test('do it red  green style')).toBe(true)
  expect(patternOf('/red.?green/')?.test('RED-GREEN')).toBe(true)
  expect(patternOf('/(/')).toBeUndefined()
  expect(patternOf('  ')).toBeUndefined()
})

test('rules pick in their order, each skill once, only skills that are installed', () => {
  const rules = [
    { skill: 'mattpocock-skills:tdd', when: ['тест'] },
    { skill: 'mattpocock-skills:tdd', when: ['фича'] },
    { skill: 'gone:skill', when: ['тест'] },
    { skill: 'mattpocock-skills:diagnosing-bugs', when: ['баг', 'падает'], args: 'fast' },
  ]
  expect(ruleHits('Тест падает на фиче', rules, SKILLS)).toEqual([
    { skill: 'mattpocock-skills:tdd', why: 'rule: тест', by: 'rule' },
    { skill: 'mattpocock-skills:diagnosing-bugs', why: 'rule: падает', by: 'rule', args: 'fast' },
  ])
  expect(ruleHits('hello', rules, SKILLS)).toEqual([])
})

test('a prompt that names a skill is left to it; a bare name needs its slash', () => {
  expect(namesSkill('run /tdd on this', SKILLS)).toBe(true)
  expect(namesSkill('use mattpocock-skills:tdd here', SKILLS)).toBe(true)
  expect(namesSkill('update the docs folder', SKILLS)).toBe(false)
  expect(namesSkill('/docs please', SKILLS)).toBe(true)
  expect(namesSkill('see /tdd-lite', SKILLS.slice(0, 1))).toBe(false)
})

test('a nod is too terse to ask a model about', () => {
  expect(isTerse('да давай')).toBe(true)
  expect(isTerse('ok')).toBe(true)
  expect(isTerse('почини падающий тест в корзине')).toBe(false)
})

test('a reply is read for picks on the list, each once, two at most', () => {
  const reply = 'Sure:\n{"picks":[{"skill":"tdd","why":"builds a feature test-first"},{"skill":"mattpocock-skills:tdd"},{"skill":"made-up"},{"skill":"docs","args":" x "},{"skill":"other:tdd-lite"}]}'
  expect(parseReply(reply, SKILLS)).toEqual([
    { skill: 'mattpocock-skills:tdd', why: 'builds a feature test-first', by: 'model' },
    { skill: 'docs', why: '', by: 'model', args: 'x' },
  ])
  expect(parseReply('{"picks":[]}', SKILLS)).toEqual([])
  expect(parseReply('no idea', SKILLS)).toBeUndefined()
  expect(parseReply('{"picks": 3}', SKILLS)).toBeUndefined()
  expect(parseReply('{broken', SKILLS)).toBeUndefined()
})

test('auto tells Claude to load the skill, suggest leaves it the call', () => {
  const picks = [{ skill: 'opsx:apply', why: 'rule: продолжи', args: 'add-auth', by: 'rule' as const }]
  const auto = directiveOf('auto', picks)
  expect(auto).toContain('Before you start, load it with the Skill tool')
  expect(auto).toContain('`opsx:apply` with args `add-auth`')
  expect(auto).toContain('the developer set it for prompts that say продолжи')
  expect(directiveOf('suggest', picks)).toContain('may fit')
})

test('the model reads the skills first, then OpenSpec, what is loaded, the exchange before, the request', () => {
  const p = promptOf('now the tests', {
    skills: SKILLS,
    hints: { 'mattpocock-skills:tdd': 'for any new feature' },
    loaded: ['docs'],
    changes: [{ name: 'add-auth', done: 2, total: 5 }],
    previous: 'add login',
    answer: 'Login added.',
  })
  expect(p.skills).toContain('- mattpocock-skills:tdd: Test-driven development. [The developer says: use it for any new feature]')
  expect(p.rest).toContain('add-auth (2/5)')
  expect(p.rest).toContain('Already loaded: docs.')
  expect(p.rest).toContain('<previous>\nadd login\n</previous>')
  expect(p.rest.endsWith('<request>\nnow the tests\n</request>')).toBe(true)
  expect(promptOf('x', { skills: SKILLS, hints: {}, loaded: [], changes: null }).rest).not.toContain('OpenSpec')
})

test('tasks are counted by their boxes, CRLF or not', () => {
  expect(progressOf('## 1\r\n- [x] a\r\n- [ ] b\r\n  * [X] c\r\ntext [ ]\r\n')).toEqual({ done: 2, total: 3 })
})

test('paths join with the separator the folder uses, a root staying a root', () => {
  expect(join('C:\\proj', 'openspec')).toBe('C:\\proj\\openspec')
  expect(join('C:\\', 'x')).toBe('C:\\x')
  expect(join('D:/proj/', 'x')).toBe('D:/proj/x')
  expect(join('/', 'x')).toBe('/x')
  expect(join('/home/me/proj', '.claude')).toBe('/home/me/proj/.claude')
})

test('a hand-written setup keeps what has the right shape; project and own merge; short names resolve', () => {
  const project = setupOf({
    rules: [{ skill: 'tdd', when: 'тест' }, { skill: 3 }, { when: ['x'] }, { skill: 'docs', when: [] }],
    hints: { tdd: 'for features', bad: 1 },
    ignored: ['docs', 7],
  })
  expect(project).toEqual({ rules: [{ skill: 'tdd', when: ['тест'] }], hints: { tdd: 'for features' }, ignored: ['docs'] })
  expect(setupOf('nonsense')).toEqual({ rules: [], hints: {}, ignored: [] })
  const own = { rules: [{ skill: 'diagnosing-bugs', when: ['баг'] }], hints: { tdd: 'mine' }, ignored: ['other:tdd-lite'] }
  const merged = resolveSetup(merge(own, project), SKILLS)
  expect(merged.rules.map(r => r.skill)).toEqual(['mattpocock-skills:tdd', 'mattpocock-skills:diagnosing-bugs'])
  expect(merged.hints).toEqual({ 'mattpocock-skills:tdd': 'for features' })
  expect(merged.ignored).toEqual(['other:tdd-lite', 'docs'])
})
