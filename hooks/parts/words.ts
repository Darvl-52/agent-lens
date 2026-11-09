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
  personOnly: string
  spentTitle: string
  openDecide: string
  openLenses: string
  showGuard: string
  ledgerName: string
  spent: (name: string, fresh: number, cached: number, calls: number, turns: number) => string
  budget: (fresh: number, budget: number, isOver: boolean) => string
  // A part whose errors were let go this session, and the last of them.
  fault: (part: string, count: number, last: string) => string
  // The turns the parts started by themselves since the person's last prompt, of how many (0: no limit).
  auto: (used: number, max: number, isHeld: boolean) => string
  list: (lines: string[]) => string
}

// Russian plural: 1 ошибка, 2 ошибки, 5 ошибок.
const plural = (n: number, one: string, few: string, many: string) => {
  const ten = n % 10
  const hundred = n % 100
  return ten === 1 && hundred !== 11 ? one : ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14) ? few : many
}

// Tokens as the person reads them: 1.2k, 340k.
const kilo = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n))

export const WORDS: Record<Lang, Words> = {
  en: {
    title: 'agent-lens',
    summary: 'Turn the parts of agent-lens on and off',
    opened: 'agent-lens parts opened.',
    keysHelp: count => `1-${count}: turn a part on or off · a: autonomy · d: to decide · l: lenses · g: guard limits · Esc: close`,
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
    },
    turned: (name, isOn) => `${name}: ${isOn ? 'on' : 'off'}.`,
    isOff: name => `${name} is off. Turn it on in /agent-lens.`,
    personOnly: 'Only you can change this: a command the agent or another plugin ran does not loosen the checks.',
    spentTitle: 'Spent this session',
    openDecide: 'd: what waits for you',
    openLenses: 'l: the branch through lenses (/changes lenses)',
    showGuard: 'g: the guard’s limits (/changes guard)',
    ledgerName: 'Points sent to Claude',
    spent: (name, fresh, cached, calls, turns) =>
      `${name}: ${kilo(fresh)} tokens${cached > 0 ? `, ${kilo(cached)} from the cache` : ''}${calls > 0 ? ` · ${calls} ${calls === 1 ? 'call' : 'calls'}` : ''}${turns > 0 ? ` · ${turns} ${turns === 1 ? 'turn' : 'turns'} of Claude` : ''}`,
    budget: (fresh, budget, isOver) => `Budget: ${kilo(fresh)} of ${kilo(budget)}${isOver ? ': spent, all by hand now' : ''}`,
    fault: (part, count, last) => `${part}: ${count} ${count === 1 ? 'error' : 'errors'}, last: ${last}`,
    auto: (used, max, isHeld) => `Turns started by itself since your prompt: ${max > 0 ? `${used}/${max}` : `${used}, no limit`}${isHeld ? ', the rest held back' : ''}`,
    list: lines => `agent-lens parts:\n${lines.join('\n')}`,
  },
  ru: {
    title: 'agent-lens',
    summary: 'Включить и выключить части agent-lens',
    opened: 'Открыты части agent-lens.',
    keysHelp: count => `1–${count} — включить или выключить часть · a — автономность · d — вам решить · l — линзы · g — лимиты guard · Esc — закрыть`,
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
    },
    turned: (name, isOn) => `${name}: ${isOn ? 'включено' : 'выключено'}.`,
    isOff: name => `${name}: выключено. Включить — /agent-lens.`,
    personOnly: 'Это меняете только вы: команда, которую запустил агент или другой плагин, проверки не ослабляет.',
    spentTitle: 'Потрачено за сессию',
    openDecide: 'd — что ждёт вас',
    openLenses: 'l — ветка через линзы (/changes lenses)',
    showGuard: 'g — пределы стража (/changes guard)',
    ledgerName: 'Пункты, отправленные Claude',
    spent: (name, fresh, cached, calls, turns) =>
      `${name}: ${kilo(fresh)} токенов${cached > 0 ? `, ${kilo(cached)} из кэша` : ''}${calls > 0 ? ` · вызовов: ${calls}` : ''}${turns > 0 ? ` · ходов Claude: ${turns}` : ''}`,
    budget: (fresh, budget, isOver) => `Бюджет: ${kilo(fresh)} из ${kilo(budget)}${isOver ? ': исчерпан, теперь всё вручную' : ''}`,
    fault: (part, count, last) => `${part}: ${count} ${plural(count, 'ошибка', 'ошибки', 'ошибок')}, последняя: ${last}`,
    auto: (used, max, isHeld) => `Ходов, начатых самим после вашего промпта: ${max > 0 ? `${used}/${max}` : `${used}, без предела`}${isHeld ? ', остальное придержано' : ''}`,
    list: lines => `Части agent-lens:\n${lines.join('\n')}`,
  },
}
