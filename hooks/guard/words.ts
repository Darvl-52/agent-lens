import type { Lang } from '../../types'
import type { Stuck } from '../../types/guard'

// Russian plural: 1 шаг, 2 шага, 5 шагов.
const plural = (n: number, one: string, few: string, many: string) => {
  const ten = n % 10
  const hundred = n % 100
  return ten === 1 && hundred !== 11 ? one : ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14) ? few : many
}

// What the guard tells the agent it watches, the person, and /changes guard, in English and Russian.
const EN = {
  // To the agent: a call refused as a loop, the note past the soft limit, the stop at the hard one.
  stuck: (why: Stuck, n: number): string =>
    `agent-lens refused this call: ${
      why === 'repeat'
        ? `it is the same call with the same input, ${n} times in a row, and its result did not change`
        : why === 'error'
          ? `it is the same call that failed ${n} times in a row`
          : 'you are going back and forth between the same two calls, and their results do not change'
    }. Repeating it will not help. Try another way, or stop and say what is in the way.`,
  soft: (minutes: number, steps: number, hardMinutes: number, hardSteps: number): string =>
    `agent-lens: you have been on this for ${minutes} min and ${steps} tool calls. If the end is not near, stop now and report what is done, what is left and what is in the way, instead of going on. At ${hardMinutes} min or ${hardSteps} calls every tool is refused.`,
  hard: (minutes: number, steps: number): string =>
    `agent-lens refused this call: the work has run ${minutes} min and ${steps} tool calls, past the limit. Call no more tools. Answer now: what is done, what is left, and what is in the way.`,
  // To the person.
  softToast: (who: string, minutes: number, steps: number): string => `${who} has run ${minutes} min · ${steps} steps: told to wrap up.`,
  hardToast: (who: string, minutes: number, steps: number): string => `${who} stopped at ${minutes} min · ${steps} steps: it reports what it did.`,
  hardTitle: 'agent-lens stopped an agent',
  main: 'Claude',
  // The row above the prompt.
  running: (who: string, minutes: number, steps: number): string => `⏱ ${who} · ${minutes} min · ${steps} steps`,
  stopped: (who: string, minutes: number, steps: number): string => `■ ${who} stopped · ${minutes} min · ${steps} steps`,
  // /changes guard.
  status: (isOn: boolean, minutes: number, steps: number): string =>
    isOn
      ? `The guard is on. Past ${Math.round(minutes / 2)} min or ${Math.round(steps / 2)} tool calls in one turn, an agent is told to wrap up; past ${minutes} min or ${steps}, every tool is refused and it reports what it did. A call made a fourth time in a row with the same result, at any time, is refused.`
      : 'The guard is off: no agent is held to a limit.',
  loops: (lines: string[]): string => (lines.length > 0 ? `\nRunning now:\n${lines.map(l => `  ${l}`).join('\n')}` : ''),
  usage: 'Usage: /changes guard on, /changes guard off, /changes guard <minutes> <steps> (the hard limit; the soft one is half)',
}

const RU: typeof EN = {
  stuck: (why, n) =>
    `agent-lens отклонил этот вызов: ${
      why === 'repeat'
        ? `это тот же вызов с тем же входом ${n} раза подряд, и результат не меняется`
        : why === 'error'
          ? `этот же вызов упал ${n} раза подряд`
          : 'ты ходишь туда-обратно между одними и теми же двумя вызовами, и их результаты не меняются'
    }. Повтор не поможет. Попробуй по-другому или остановись и скажи, что мешает.`,
  soft: (minutes, steps, hardMinutes, hardSteps) =>
    `agent-lens: ты на этом ${minutes} мин и ${steps} ${plural(steps, 'вызов', 'вызова', 'вызовов')} инструментов. Если до конца далеко, остановись сейчас и доложи, что сделано, что осталось и что мешает, а не продолжай. На ${hardMinutes} мин или ${hardSteps} вызовах любой инструмент будет отклонён.`,
  hard: (minutes, steps) =>
    `agent-lens отклонил этот вызов: работа идёт ${minutes} мин и ${steps} ${plural(steps, 'вызов', 'вызова', 'вызовов')} инструментов, это за пределом. Больше не вызывай инструменты. Ответь сейчас: что сделано, что осталось и что мешает.`,
  softToast: (who, minutes, steps) => `${who} работает ${minutes} мин · ${steps} ${plural(steps, 'шаг', 'шага', 'шагов')}: попросил закругляться.`,
  hardToast: (who, minutes, steps) => `${who} остановлен на ${minutes} мин · ${steps} ${plural(steps, 'шаге', 'шагах', 'шагах')}: пишет отчёт о сделанном.`,
  hardTitle: 'agent-lens остановил агента',
  main: 'Claude',
  running: (who, minutes, steps) => `⏱ ${who} · ${minutes} мин · ${steps} ${plural(steps, 'шаг', 'шага', 'шагов')}`,
  stopped: (who, minutes, steps) => `■ ${who} остановлен · ${minutes} мин · ${steps} ${plural(steps, 'шаг', 'шага', 'шагов')}`,
  status: (isOn, minutes, steps) =>
    isOn
      ? `Сторож включён. Если агент за один ход работает дольше ${Math.round(minutes / 2)} мин или ${Math.round(steps / 2)} вызовов инструментов, его просят закругляться; дольше ${minutes} мин или ${steps} — любой инструмент отклоняется, и агент пишет отчёт о сделанном. Вызов, который в четвёртый раз подряд даёт тот же результат, отклоняется всегда.`
      : 'Сторож выключен: ни один агент не ограничен.',
  loops: lines => (lines.length > 0 ? `\nСейчас работают:\n${lines.map(l => `  ${l}`).join('\n')}` : ''),
  usage: 'Как вызвать: /changes guard on, /changes guard off, /changes guard <минуты> <шаги> (жёсткий предел; мягкий — половина)',
}

export type Words = typeof EN
export const WORDS: Record<Lang, Words> = { en: EN, ru: RU }
