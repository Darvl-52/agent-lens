import { expect, test } from 'claude-code/testing'

import { hashOf, isAdvice, isReviewSkill, offersOf, skipOf } from '../hooks/router/route'

// The prompt the router once gave skill-creator, with a description it made up.
const PLUGINS = 'Можешь посмотреть на Agent Lens и на Figma Taste. И скажи, можно ли в этих моих плагинах что-то улучшить? Что бы ты добавил?'

test('an open question for an opinion or ideas reads as advice, a request for the work does not', () => {
  expect(isAdvice(PLUGINS)).toBe(true)
  expect(isAdvice('Как тебе такая структура модулей?')).toBe(true)
  expect(isAdvice('What do you think of this API shape?')).toBe(true)
  expect(isAdvice('Take a look at the router and tell me what could be better')).toBe(true)
  expect(isAdvice('Улучши поиск по каталогу')).toBe(false)
  expect(isAdvice('Почини выгрузку отчёта в Excel')).toBe(false)
  // A question that also says to change something is work.
  expect(isAdvice('Посмотри на роутер, скажи что не так и исправь')).toBe(false)
})

test('a skill is one for reviewing by its own description', () => {
  expect(isReviewSkill({ name: 'code-review', description: 'Review the current diff for correctness bugs.' })).toBe(true)
  expect(isReviewSkill({ name: 'skill-creator', description: 'Create new skills, modify and improve existing skills.' })).toBe(false)
})

test('the model is not waited on for a short prompt, a slash command, or a short reply to Claude’s question', () => {
  expect(skipOf('ну и', '')).toBe('short')
  expect(skipOf('ага, понятно', '')).toBe('short')
  // A short request for work is routed: the one most likely to want grilling.
  expect(skipOf('Сделай авторизацию', '')).toBeUndefined()
  expect(skipOf('fix login', '')).toBeUndefined()
  expect(skipOf('/compact keep the router notes', '')).toBe('command')
  expect(skipOf('второй вариант, через кэш', 'Можно так:\n1. В памяти\n2. Через кэш\nКакой берём?')).toBe('answer')
  expect(skipOf('sessions please, in redis', 'Done. Sessions or tokens?')).toBe('answer')
  // A reply that starts new work is routed still; so is a prompt after an answer that asks nothing.
  expect(skipOf('да, и добавь тесты на корзину', 'Сделать так?')).toBeUndefined()
  expect(skipOf('second option with the cache', 'Done.')).toBeUndefined()
})

test('a hash tells strings apart and gives the same one the same key', () => {
  expect(hashOf('a\u0000b')).toBe(hashOf('a\u0000b'))
  expect(hashOf('a\u0000b')).not.toBe(hashOf('a\u0000c'))
})

test('a skill taken for three prompts that share a word is offered as a rule on it, once', () => {
  const taken = [
    { skill: 'mattpocock-skills:tdd', prompt: 'Добавь фильтр по цене в каталог' },
    { skill: 'mattpocock-skills:tdd', prompt: 'Сделай фильтры по бренду' },
    { skill: 'mattpocock-skills:tdd', prompt: 'Ещё фильтр по наличию, пожалуйста' },
    { skill: 'docs', prompt: 'Опиши фильтр в доке' },
  ]
  expect(offersOf(taken, [], [])).toEqual([{ skill: 'mattpocock-skills:tdd', word: 'фильтр', count: 3 }])
  // Twice is not yet a habit; a rule that fires on the word already, or a no, ends the offer.
  expect(offersOf(taken.slice(1), [], [])).toEqual([])
  expect(offersOf(taken, [{ skill: 'mattpocock-skills:tdd', when: ['фильт'] }], [])).toEqual([])
  expect(offersOf(taken, [], ['mattpocock-skills:tdd'])).toEqual([])
  // The work verbs every prompt shares are no rule.
  expect(offersOf([{ skill: 'x', prompt: 'Добавь A' }, { skill: 'x', prompt: 'Добавь B' }, { skill: 'x', prompt: 'Добавь C' }], [], [])).toEqual([])
})
