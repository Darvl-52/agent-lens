import type { Lang, Part } from '../../types'

export type Words = {
  title: string
  summary: string
  opened: string
  keysHelp: (count: number) => string
  on: string
  off: string
  parts: Record<Part, { name: string; what: string }>
  turned: (name: string, isOn: boolean) => string
  isOff: (name: string) => string
  list: (lines: string[]) => string
}

export const WORDS: Record<Lang, Words> = {
  en: {
    title: 'agent-lens',
    summary: 'Turn the parts of agent-lens on and off',
    opened: 'agent-lens parts opened.',
    keysHelp: count => `1-${count}: turn a part on or off · Esc: close`,
    on: '● on ',
    off: '○ off',
    parts: {
      review: { name: 'Review of changes', what: "each turn's diff reviewed against the request and the rules, /changes" },
      live: { name: 'Rules while Claude edits', what: 'each edit checked against CLAUDE.md as it lands' },
      spec: { name: 'OpenSpec change', what: 'the change in view on the row, /spec' },
      router: { name: 'Skill router', what: 'a skill picked for each prompt, /router' },
      guard: { name: 'Guard', what: "limits on each agent's turn, /changes guard" },
      lenses: { name: 'Lenses', what: 'the branch read through the lenses, /changes lenses' },
      setup: { name: 'Project setup', what: "/setup-project, the project's checks at the end of a turn" },
      security: { name: 'Security', what: 'secrets refused, the code the agent writes read for holes, /security' },
    },
    turned: (name, isOn) => `${name}: ${isOn ? 'on' : 'off'}.`,
    isOff: name => `${name} is off. Turn it on in /agent-lens.`,
    list: lines => `agent-lens parts:\n${lines.join('\n')}`,
  },
  ru: {
    title: 'agent-lens',
    summary: 'Включить и выключить части agent-lens',
    opened: 'Открыты части agent-lens.',
    keysHelp: count => `1–${count} — включить или выключить часть · Esc — закрыть`,
    on: '● вкл ',
    off: '○ выкл',
    parts: {
      review: { name: 'Ревью правок', what: 'дифф хода сверяется с запросом и правилами, /changes' },
      live: { name: 'Правила во время правок', what: 'каждая правка сверяется с CLAUDE.md, пока ложится' },
      spec: { name: 'Change OpenSpec', what: 'change в работе в строке над промптом, /spec' },
      router: { name: 'Роутер скиллов', what: 'скилл под каждый промпт, /router' },
      guard: { name: 'Страж', what: 'пределы на ход агента, /changes guard' },
      lenses: { name: 'Линзы', what: 'ветка через линзы ревью, /changes lenses' },
      setup: { name: 'Настройка проекта', what: '/setup-project, проверки проекта в конце хода' },
      security: { name: 'Безопасность', what: 'секреты не пропускаются, код агента читается на дыры, /security' },
    },
    turned: (name, isOn) => `${name}: ${isOn ? 'включено' : 'выключено'}.`,
    isOff: name => `${name}: выключено. Включить — /agent-lens.`,
    list: lines => `Части agent-lens:\n${lines.join('\n')}`,
  },
}
