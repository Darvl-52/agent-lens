import { expect, test } from 'claude-code/testing'
import type { CommandInfo } from 'claude-code'

import {
  catalogOf,
  directiveOf,
  gapsOf,
  isSpecSkill,
  isTerse,
  join,
  kindOf,
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
  skipsQuestions,
  stageOf,
  stageSkills,
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
  expect(isTerse('Ок, спасибо!')).toBe(true)
  expect(isTerse('почини падающий тест в корзине')).toBe(false)
  // A short request for work is no nod: it is the one most likely to want grilling.
  expect(isTerse('Сделай авторизацию')).toBe(false)
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

test('a reply says what the request is; one that does not leaves its picks standing', () => {
  expect(kindOf('{"kind":"question","picks":[]}')).toBe('question')
  expect(kindOf('Sure: {"kind":"work","picks":[{"skill":"tdd"}]}')).toBe('work')
  expect(kindOf('{"picks":[{"skill":"tdd"}]}')).toBeUndefined()
  expect(kindOf('{"kind":"maybe","picks":[]}')).toBeUndefined()
  expect(kindOf('{broken')).toBeUndefined()
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
  expect(promptOf('x', { skills: SKILLS, hints: {}, loaded: [], changes: null }).rest).toContain('The project does not use OpenSpec.')
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

const STAGED = catalogOf(
  [
    ...COMMANDS,
    { name: 'mattpocock-skills:grilling', description: 'Grill the user about a plan.', source: 'plugin', plugin: 'mattpocock-skills' },
    { name: 'mattpocock-skills:domain-modeling', description: 'Build the domain model.', source: 'plugin', plugin: 'mattpocock-skills' },
    { name: 'opsx:propose', description: 'Propose an OpenSpec change.', source: 'user' },
  ],
  [],
)

test('a reply says where the work starts, what it leaves open, and how sure each pick is', () => {
  const reply = '{"read":"vague","kind":"work","stage":"grill","gaps":"  which login methods, sessions or tokens ","picks":[{"skill":"tdd","fit":"maybe"},{"skill":"docs","fit":"sure"}]}'
  expect(stageOf(reply)).toBe('grill')
  expect(gapsOf(reply)).toBe('which login methods, sessions or tokens')
  expect(parseReply(reply, SKILLS)).toEqual([
    { skill: 'mattpocock-skills:tdd', why: '', by: 'model', fit: 'maybe' },
    { skill: 'docs', why: '', by: 'model' },
  ])
  expect(stageOf('{"kind":"work","stage":"later"}')).toBeUndefined()
  expect(stageOf('{"kind":"work","picks":[]}')).toBeUndefined()
  expect(gapsOf('{"gaps":""}')).toBeUndefined()
})

test('a request that says to skip the questions is told apart, in either language', () => {
  expect(skipsQuestions('Сделай авторизацию, без вопросов')).toBe(true)
  expect(skipsQuestions('сразу делай кэш')).toBe(true)
  expect(skipsQuestions('Add caching, no questions')).toBe(true)
  expect(skipsQuestions('just do it')).toBe(true)
  expect(skipsQuestions('Сделай авторизацию')).toBe(false)
  expect(skipsQuestions('ответь на вопросы в тикете')).toBe(false)
})

test('a stage starts with its skills: grilling, with domain modeling where the project keeps docs; the spec where it uses OpenSpec', () => {
  expect(stageSkills('grill', STAGED, { hasSpec: false, hasDocs: false })).toEqual(['mattpocock-skills:grilling'])
  expect(stageSkills('grill', STAGED, { hasSpec: false, hasDocs: true })).toEqual(['mattpocock-skills:grilling', 'mattpocock-skills:domain-modeling'])
  expect(stageSkills('spec', STAGED, { hasSpec: true, hasDocs: false })).toEqual(['opsx:propose'])
  expect(stageSkills('spec', STAGED, { hasSpec: false, hasDocs: false })).toEqual([])
  expect(stageSkills('go', STAGED, { hasSpec: true, hasDocs: true })).toEqual([])
  // Not installed, the stage has no skill, and the work goes as it would.
  expect(stageSkills('grill', SKILLS, { hasSpec: true, hasDocs: true })).toEqual([])
  expect(isSpecSkill('opsx:propose')).toBe(true)
  expect(isSpecSkill('openspec-propose')).toBe(true)
  expect(isSpecSkill('other:propose')).toBe(false)
})

test('grilling comes before any code; a sure pick is loaded, a maybe one offered', () => {
  const grill = directiveOf('auto', [{ skill: 'mattpocock-skills:grilling', why: '', by: 'model', isStage: true }], { stage: 'grill', gaps: 'which login methods', loaded: [] })
  expect(grill).toContain('This request leaves decisions open (which login methods). Before any plan or code, load `mattpocock-skills:grilling`')
  expect(grill).not.toContain('loaded before')
  const docs = directiveOf(
    'auto',
    [
      { skill: 'mattpocock-skills:grilling', why: '', by: 'model', isStage: true },
      { skill: 'mattpocock-skills:domain-modeling', why: '', by: 'model', isStage: true },
    ],
    { stage: 'grill', loaded: ['mattpocock-skills:grilling'] },
  )
  expect(docs).toContain('`mattpocock-skills:grilling` and `mattpocock-skills:domain-modeling`')
  expect(docs).toContain('loaded before: follow it again for this request')
  expect(docs).toContain('writing the terms and decisions into the project’s docs')
  const spec = directiveOf('auto', [{ skill: 'opsx:propose', why: '', by: 'model', isStage: true }], { stage: 'spec', loaded: [], afterGrilling: true })
  expect(spec).toContain('The grilling is settled: load `opsx:propose`')
  expect(spec).toContain('from what the grilling settled')
  const mixed = directiveOf('auto', [
    { skill: 'mattpocock-skills:tdd', why: 'a feature', by: 'model' },
    { skill: 'docs', why: 'maybe docs', by: 'model', fit: 'maybe' },
  ])
  expect(mixed).toContain('This request fits the skill below. Before you start, load it with the Skill tool and follow it:\n- `mattpocock-skills:tdd`: a feature')
  expect(mixed).toContain('This skill may fit the request; load it with the Skill tool if it does:\n- `docs`: maybe docs')
  expect(directiveOf('suggest', [{ skill: 'mattpocock-skills:grilling', why: '', by: 'model', isStage: true }], { stage: 'grill', loaded: [] })).toContain('may leave decisions open')
})

test('the model reads the picks Claude went on without, the skills it often leaves, and the grilling under way', () => {
  const p = promptOf('ок, давай', {
    skills: SKILLS,
    hints: {},
    loaded: [],
    changes: [],
    grilling: 'Сделай авторизацию',
    declined: [{ skill: 'mattpocock-skills:tdd', prompt: 'Объясни, как работает кэш' }],
    tracks: [
      { skill: 'mattpocock-skills:tdd', offered: 4, taken: 1 },
      { skill: 'docs', offered: 4, taken: 4 },
      { skill: 'mattpocock-skills:diagnosing-bugs', offered: 1, taken: 0 },
    ],
  })
  expect(p.rest).toContain('Claude often went on without these sure picks; pick them only for their own kind of work: mattpocock-skills:tdd (loaded 1 of 4).')
  expect(p.rest).not.toContain('docs (loaded')
  expect(p.rest).not.toContain('diagnosing-bugs (loaded')
  expect(p.rest).toContain('- mattpocock-skills:tdd for «Объясни, как работает кэш»')
  expect(p.rest).toContain('<grilled>\nСделай авторизацию\n</grilled>')
  expect(p.rest.endsWith('<request>\nок, давай\n</request>')).toBe(true)
})
