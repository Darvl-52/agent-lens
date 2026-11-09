import type { Lang } from '../../types'

// Russian plural: 1 ход, 2 хода, 5 ходов.
const plural = (n: number, one: string, few: string, many: string) => {
  const ten = n % 10
  const hundred = n % 100
  return ten === 1 && hundred !== 11 ? one : ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14) ? few : many
}

// What the outbox says of a prompt it holds back, in English and Russian.
const EN = {
  // A part's prompt past the turns the mod may start by itself after one of the person's.
  autoSpent: (max: number) => `agent-lens started ${max} turns by itself since your last prompt: the rest waits for your next one`,
}

export type Words = typeof EN

const RU: Words = {
  autoSpent: max => `agent-lens сам начал ${max} ${plural(max, 'ход', 'хода', 'ходов')} после вашего последнего промпта: остальное ждёт следующего`,
}

export const WORDS: Record<Lang, Words> = { en: EN, ru: RU }
