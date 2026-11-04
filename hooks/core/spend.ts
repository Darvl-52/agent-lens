import type { ModelUsage, PluginOptions } from 'claude-code'

// What each part of the mod cost this session: its own model calls, the subagents it started, and
// the main turns its prompts started, which the main model pays for. Past the budget, where one is
// set, the mod is by hand till the session ends: no findings go to Claude unasked, the critic waits
// for its key; the gate and the checks of each turn go on, as they do by hand.

type Usage = ModelUsage
// Tokens read fresh and written (the price of a call), those read from the cache, apart, as they cost
// a tenth; the calls and subagent runs, and the main turns.
export type PartSpend = { fresh: number; cached: number; calls: number; turns: number }

const spent = new Map<string, PartSpend>()
// The subagents each part started, by id: their runs are the part's.
const agents = new Map<string, string>()
let budget = 0
let isOver = false

const positive = (value: unknown) => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

export function configureSpend(options: PluginOptions) {
  budget = positive(options.budget)
}

const freshOf = (u: Usage) => (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)

// A call of `part`'s, or a main turn its prompt started.
export function spendOn(part: string, u: Usage | undefined, isTurn = false) {
  if (!u) return
  const was = spent.get(part) ?? { fresh: 0, cached: 0, calls: 0, turns: 0 }
  spent.set(part, { fresh: was.fresh + freshOf(u), cached: was.cached + (u.cache_read_input_tokens ?? 0), calls: was.calls + (isTurn ? 0 : 1), turns: was.turns + (isTurn ? 1 : 0) })
  if (budget > 0 && totalFresh() >= budget) isOver = true
}

export function ownAgent(agentId: string | undefined, part: string) {
  if (agentId) agents.set(agentId, part)
}

// A subagent's run ended: its cost is its part's, where one of the parts started it.
export function spendAgent(agentId: string, u: Usage | undefined) {
  const part = agents.get(agentId)
  if (part) spendOn(part, u)
}

const totalFresh = () => [...spent.values()].reduce((n, s) => n + s.fresh, 0)

export const spentNow = () => [...spent.entries()].sort((a, b) => b[1].fresh - a[1].fresh)
export const budgetNow = () => ({ budget, fresh: totalFresh(), isOver })
// Past the budget, nothing goes unasked.
export const isOverBudget = () => isOver

// A /clear or /resume: a new count against the same budget.
export function clearSpend() {
  spent.clear()
  agents.clear()
  isOver = false
}
