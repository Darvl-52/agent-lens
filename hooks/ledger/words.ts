import type { Lang } from '../../types'

// A point the ledger sends to Claude, numbered across the session, by where it is.
export type Said = { n: number; where: string; text: string; fix?: string }

const listOf = (points: readonly Said[]) => points.map(p => `#${p.n} ${p.where} — ${p.text}${p.fix ? ` Fix: ${p.fix}` : ''}`).join('\n')

const EN = {
  // The points that held a second look, sent as one prompt; Claude's verdicts come back as lines.
  prompt: (points: readonly Said[]) =>
    `agent-lens: the checks of your work found these. Check each against the code: fix what holds; where one does not, say why. A fix is a diff too: mind what it costs. Change nothing else.\n${listOf(points)}\n\nEnd your answer with one line for each, as \`#${points[0]?.n ?? 1} fixed\` or \`#${points[0]?.n ?? 1} rejected: why\`.`,
  insist: (p: Said, reason: string) => `I read why you rejected #${p.n} (${reason}) and the point holds: fix it.\n${listOf([p])}\n\nEnd your answer with \`#${p.n} fixed\`.`,
  // A point the mod raised to the person, sent on their word.
  insistMod: (p: Said) => `I looked at this and it does not stay: fix it.\n${listOf([p])}\n\nEnd your answer with \`#${p.n} fixed\`.`,
  leave: 'leave it',
  fixIt: 'Claude fixes it',
  title: 'To decide',
  band: (n: number) => `${n} to decide`,
  overBudget: (budget: number) => `agent-lens spent its ${budget} tokens: by hand till the session ends`,
  none: 'Nothing waits for you: what the checks found went to Claude, and Claude took it.',
  noneByHand: 'Nothing waits for you here: by hand, the findings wait on their own panes.',
  noWord: 'Claude ended with no line for it.',
  stopped: 'The turn was stopped before Claude answered it.',
  specQuestions: (n: number) => `The spec: ${n} ${n === 1 ? 'question' : 'questions'} Claude left yours (a product choice, a cost).`,
  openSpec: 'open Decide',
  claude: (reason: string) => `Claude: ${reason}`,
  agree: 'Claude is right',
  fixAnyway: 'fix it anyway',
  stats: (sent: number, fixed: number, rejected: number) => `This session: ${sent} sent to Claude, ${fixed} fixed, ${rejected} rejected.`,
  keys: 'y: leave the first as Claude says · f: have it fixed · Esc: close',
  opened: 'Opened what waits for you.',
  autonomy: 'Autonomy',
  modes: { manual: 'by hand: findings wait for your key (the gate and the notes on a turn go as before)', auto: 'auto: what holds goes to Claude, you decide the disputes', full: 'full: the minor points go too' },
}

export type Words = typeof EN

const RU: Words = {
  prompt: points =>
    `agent-lens: проверки твоей работы нашли это. Сверь каждый пункт с кодом: исправь то, что подтверждается; где пункт не подтверждается, скажи почему. Свой фикс — тоже дифф: смотри на его цену. Больше ничего не меняй.\n${listOf(points)}\n\nЗакончи ответ строкой на каждый пункт: \`#${points[0]?.n ?? 1} fixed\` или \`#${points[0]?.n ?? 1} rejected: почему\`.`,
  insist: (p, reason) => `Я прочитал, почему ты отклонил #${p.n} (${reason}), и пункт в силе: исправь.\n${listOf([p])}\n\nЗакончи ответ строкой \`#${p.n} fixed\`.`,
  insistMod: p => `Я посмотрел, так не оставляем: исправь.\n${listOf([p])}\n\nЗакончи ответ строкой \`#${p.n} fixed\`.`,
  leave: 'оставить',
  fixIt: 'пусть Claude исправит',
  title: 'Вам решить',
  band: n => `${n} вам решить`,
  overBudget: budget => `agent-lens потратил свои ${budget} токенов: до конца сессии всё вручную`,
  none: 'Ничего не ждёт вас: найденное ушло Claude, и Claude это принял.',
  noneByHand: 'Здесь ничего не ждёт вас: вручную находки ждут в своих pane.',
  noWord: 'Claude закончил ответ без строки про этот пункт.',
  stopped: 'Ход остановили раньше, чем Claude ответил.',
  specQuestions: n => `Спека: вопросов, которые Claude оставил вам (выбор продукта, цена): ${n}.`,
  openSpec: 'открыть «Решить»',
  claude: reason => `Claude: ${reason}`,
  agree: 'Claude прав',
  fixAnyway: 'всё равно исправить',
  stats: (sent, fixed, rejected) => `За сессию: ${sent} отправлено Claude, ${fixed} исправлено, ${rejected} отклонено.`,
  keys: 'y — оставить первый, как говорит Claude · f — исправить его · Esc — закрыть',
  opened: 'Открыто то, что ждёт вас.',
  autonomy: 'Автономность',
  modes: { manual: 'вручную: находки ждут вашей кнопки (гейт и заметки к ходу уходят как раньше)', auto: 'авто: подтверждённое уходит Claude, споры решаете вы', full: 'полная: уходят и мелочи' },
}

export const WORDS: Record<Lang, Words> = { en: EN, ru: RU }
